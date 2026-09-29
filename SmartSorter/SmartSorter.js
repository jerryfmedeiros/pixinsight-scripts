/*
 * SmartSorter.js
 *
 * Rejects bad light frames using statistics from the session itself.
 * Frames are measured with SubframeSelector, grouped by object, filter,
 * exposure, gain and binning, and each metric is compared against:
 *
 *   - a local trend through the neighbouring frames in time, which catches
 *     short events (a passing cloud, a gust, a guiding glitch), and
 *   - a trend against airmass for the whole group, which follows the normal
 *     drift as the target sinks but catches long bad stretches (a cloud bank,
 *     an obstruction) that the local check would absorb.
 *
 * Spread is estimated with the MAD, so limits loosen on a variable night and
 * tighten on a steady one. There are no user tolerances.
 *
 * Rejected frames go to a Rejected_Frames folder next to the frame. Frames
 * already there are re-measured on every run, so running twice gives the
 * same result and a frame that no longer fails can be restored.
 *
 * Note: the PJSR preprocessor strips everything after a double slash, even
 * inside strings and regular expressions. Keep them out of code lines.
 */

#feature-id    Utilities > Smart Sorter
#feature-info  Rejects bad light frames using thresholds derived from each session's own statistics (FWHM, eccentricity, star count, background and PSF signal weight).

#include <pjsr/Sizer.jsh>
#include <pjsr/StdButton.jsh>
#include <pjsr/StdIcon.jsh>
#include <pjsr/DataType.jsh>

#define TITLE   "Smart Sorter"
#define VERSION "1.0.0"

#define SETTINGS_KEY "SmartSorter"

var LOCAL_SIGMA   = 3.0;  // limit against neighbouring frames
var TREND_SIGMA   = 4.0;  // limit against the airmass trend
var CLIP_SIGMA    = 3.0;  // outlier clipping while fitting the trend
var MIN_GROUP     = 5;    // smaller groups are kept as they are
var REJECT_FOLDER = "Rejected_Frames";
var REPORT_NAME   = "SmartSorter_report.csv";

// bad:      +1 if higher is worse, -1 if lower is worse
// log:      compare ratios rather than differences
// minSigma: floor on the spread, so a very steady night doesn't reject
//           noise (ln units for log metrics)
var METRICS = [
   { key: "fwhm",   column: "fwhm",            label: "FWHM",       bad: +1, log: true,  minSigma: 0.03 },
   { key: "ecc",    column: "eccentricity",    label: "Ecc",        bad: +1, log: false, minSigma: 0.04 },
   { key: "stars",  column: "stars",           label: "Stars",      bad: -1, log: true,  minSigma: 0.05 },
   { key: "median", column: "median",          label: "Background", bad: +1, log: true,  minSigma: 0.02 },
   { key: "psfsw",  column: "psfsignalweight", label: "PSF SigW",   bad: -1, log: true,  minSigma: 0.05 }
];

/*
 * Statistics
 */

function median(values) {
   if (values.length == 0)
      return NaN;
   var a = values.slice().sort(function (x, y) { return x - y; });
   var mid = a.length >> 1;
   return (a.length % 2) ? a[mid] : 0.5 * (a[mid - 1] + a[mid]);
}

// MAD scaled to a normal sigma
function robustSigma(values, center) {
   var dev = values.map(function (v) { return Math.abs(v - center); });
   return 1.4826 * median(dev);
}

// Theil-Sen line: median of pairwise slopes, then median intercept.
function theilSen(x, y) {
   var slopes = [];
   for (var i = 0; i < x.length; i++)
      for (var j = i + 1; j < x.length; j++)
         if (x[j] != x[i])
            slopes.push((y[j] - y[i]) / (x[j] - x[i]));
   var b = slopes.length ? median(slopes) : 0;
   var a = median(y.map(function (v, i) { return v - b * x[i]; }));
   return { a: a, b: b };
}

// Theil-Sen start, then least squares on the points within CLIP_SIGMA of the
// line, repeated until the set of kept points stops changing.
function robustLineFit(x, y) {
   var n = x.length;
   var line = theilSen(x, y);
   var a = line.a, b = line.b;
   var sigma = 0, keep = null;

   for (var iter = 0; iter < 20; iter++) {
      var res = y.map(function (v, i) { return v - (a + b*x[i]); });
      var kept = keep ? res.filter(function (r, i) { return keep[i]; }) : res;
      sigma = robustSigma(kept, median(kept));
      var newKeep = res.map(function (r) { return Math.abs(r) <= CLIP_SIGMA*sigma; });

      var sx = 0, sy = 0, sxx = 0, sxy = 0, m = 0;
      for (var i = 0; i < n; i++)
         if (newKeep[i]) {
            sx += x[i]; sy += y[i]; sxx += x[i]*x[i]; sxy += x[i]*y[i]; m++;
         }
      if (m < 3)
         break;
      var den = m*sxx - sx*sx;
      b = (Math.abs(den) > 1e-12) ? (m*sxy - sx*sy)/den : 0;
      a = (sy - b*sx)/m;

      var same = keep != null;
      for (var i = 0; same && i < n; i++)
         if (keep[i] != newKeep[i])
            same = false;
      keep = newKeep;
      if (same)
         break;
   }
   return { a: a, b: b, sigma: sigma };
}

// Value of the local trend at frame i, from the 2*half nearest frames in time
// (not including i). A line rather than a median, because at the start and end
// of a session all the neighbours are on one side and any drift would bias a
// median.
function localBaseline(values, t, i, half) {
   var xs = [], ys = [];
   for (var d = 1; xs.length < 2*half && (i - d >= 0 || i + d < values.length); d++) {
      if (i - d >= 0 && isFinite(values[i - d])) {
         xs.push(t[i - d]); ys.push(values[i - d]);
      }
      if (i + d < values.length && isFinite(values[i + d])) {
         xs.push(t[i + d]); ys.push(values[i + d]);
      }
   }
   var line = theilSen(xs, ys);
   return line.a + line.b*t[i];
}

/*
 * Files and headers
 */

function isImageFile(name) {
   return /\.(fits|fit|fts|xisf)$/i.test(name);
}

// Image files under dir, including one level of Rejected_Frames folders.
function findFiles(dir, out, inRejected) {
   var find = new FileFind;
   if (find.begin(dir + "/*"))
      do {
         if (find.name == "." || find.name == "..")
            continue;
         var path = dir + "/" + find.name;
         if (find.isDirectory) {
            if (!inRejected)
               findFiles(path, out, find.name == REJECT_FOLDER);
         } else if (isImageFile(find.name))
            out.push({ path: path, inRejected: inRejected });
      } while (find.next());
   return out;
}

// FITS keywords without loading the pixel data.
function readKeywords(path) {
   var kw = {};
   var format = new FileFormat(File.extractExtension(path).toLowerCase(), true, false);
   if (format.isNull)
      return kw;
   var file = new FileFormatInstance(format);
   if (file.isNull)
      return kw;
   try {
      if (!file.open(path, "verbosity 0"))
         return kw;
      file.keywords.forEach(function (k) {
         kw[k.name] = k.strippedValue.replace(/'/g, "").trim();
      });
   } finally {
      file.close();
   }
   return kw;
}

// ISO 8601 (DATE-OBS) to milliseconds, NaN if it can't be parsed.
function parseDate(s) {
   var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d+)?/.exec(s || "");
   if (!m)
      return NaN;
   var ms = m[7] ? Math.round(parseFloat(m[7])*1000) : 0;
   return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], ms);
}

function folderOf(path) {
   return path.substring(0, path.lastIndexOf("/"));
}

function pathKey(path) {
   return String(path).replace(/\\/g, "/").toLowerCase();
}

// dir/fileName, or dir/name_N.ext if that already exists.
function uniqueDestination(dir, fileName) {
   var dest = dir + "/" + fileName;
   var name = File.extractName(fileName);
   var ext = File.extractExtension(fileName);
   for (var i = 1; File.exists(dest); i++)
      dest = dir + "/" + name + "_" + i + ext;
   return dest;
}

/*
 * SubframeSelector
 */

// The measurements table layout changes between PixInsight versions, so the
// columns are looked up by name. toSource() lists them in a comment after
// "P.measurements = [", possibly wrapped over several lines.
function measurementColumns(src) {
   var start = src.search(/P\.measurements\s*=\s*\[/);
   if (start < 0)
      return null;
   var COMMENT = "/" + "/";
   var lines = src.substring(start).split(/\r?\n/);
   var ids = [];
   for (var i = 0; i < lines.length; i++) {
      if (i > 0 && lines[i].trim().indexOf(COMMENT) != 0)
         break;
      var c = lines[i].indexOf(COMMENT);
      if (c >= 0)
         ids = ids.concat(lines[i].substring(c + 2).split(","));
   }
   var cols = {}, n = 0;
   ids.forEach(function (id) {
      id = id.trim().toLowerCase().replace(/^measurement/, "");
      if (id.length > 0)
         cols[id] = n++;
   });
   if (cols.path === undefined)
      cols.path = cols.filepath;
   return cols;
}

function printMeasurementLayout(P, src) {
   var start = src.search(/P\.measurements\s*=/);
   console.writeln(start < 0 ? "P.measurements not found in the instance source."
                             : src.substring(start).split(/\r?\n/).slice(0, 6).join("\n"));
   var rows = P.measurements;
   console.writeln("Rows: " + (rows ? rows.length : "none"));
   if (rows && rows.length > 0)
      console.writeln("Row 0: " + rows[0].map(function (v, i) { return i + "=" + v; }).join(" | "));
}

// Returns { byPath, cols } with the metrics for each measured file.
function measureFrames(paths) {
   var P = new SubframeSelector;
   P.routine = SubframeSelector.prototype.MeasureSubframes;
   P.nonInteractive = true;
   P.subframes = paths.map(function (p) { return [true, p]; });
   if (!P.executeGlobal())
      throw new Error("SubframeSelector measurement failed.");

   var src = P.toSource("JavaScript", "P", 0);
   var cols = measurementColumns(src);
   if (cols == null || cols.path === undefined) {
      console.criticalln("Unrecognised SubframeSelector measurements layout:");
      printMeasurementLayout(P, src);
      throw new Error("Unrecognised SubframeSelector measurements layout. Nothing was moved.");
   }

   var byPath = {};
   P.measurements.forEach(function (row) {
      var m = {};
      METRICS.forEach(function (metric) {
         var c = cols[metric.column];
         m[metric.key] = (c !== undefined) ? Number(row[c]) : NaN;
      });
      byPath[pathKey(row[cols.path])] = m;
   });
   return { byPath: byPath, cols: cols };
}

/*
 * Scoring
 */

function metricValue(frame, metric) {
   var v = frame.m[metric.key];
   if (!isFinite(v))
      return NaN;
   if (metric.log)
      return (v > 0) ? Math.log(v) : NaN;
   return v;
}

// Scores one group of comparable frames, sorted by time. A frame is rejected
// if any metric is worse than LOCAL_SIGMA against its neighbours or
// TREND_SIGMA against the group trend.
function scoreGroup(frames) {
   var n = frames.length;
   var half = Math.max(3, Math.min(10, Math.round(n/6)));

   var hours = frames.map(function (f, i) {
      return isFinite(f.time) ? (f.time - frames[0].time)/3600000 : i;
   });
   var useAirmass = frames.every(function (f) { return f.airmass > 0; });
   var x = useAirmass ? frames.map(function (f) { return f.airmass; }) : hours;
   var trendName = useAirmass ? "airmass trend" : "session trend";

   METRICS.forEach(function (metric) {
      var values = frames.map(function (f) { return metricValue(f, metric); });
      var xs = [], ys = [];
      values.forEach(function (v, i) {
         if (isFinite(v)) {
            xs.push(x[i]); ys.push(v);
         }
      });
      if (ys.length < MIN_GROUP)
         return;

      var local = values.map(function (v, i) {
         return isFinite(v) ? v - localBaseline(values, hours, i, half) : NaN;
      });
      var localOk = local.filter(isFinite);
      var localCenter = median(localOk);
      var localSigma = Math.max(robustSigma(localOk, localCenter), metric.minSigma);

      var fit = robustLineFit(xs, ys);
      var trendSigma = Math.max(fit.sigma, metric.minSigma);

      frames.forEach(function (f, i) {
         if (!isFinite(local[i]))
            return;
         var zLocal = metric.bad*(local[i] - localCenter)/localSigma;
         var zTrend = metric.bad*(values[i] - (fit.a + fit.b*x[i]))/trendSigma;
         f.z[metric.key] = Math.max(zLocal, zTrend);
         if (zLocal > LOCAL_SIGMA)
            f.reasons.push(metric.label + " " + zLocal.toFixed(1) + " sigma vs neighbours");
         else if (zTrend > TREND_SIGMA)
            f.reasons.push(metric.label + " " + zTrend.toFixed(1) + " sigma vs " + trendName);
      });
   });

   frames.forEach(function (f) {
      if (f.reasons.length > 0)
         f.status = "REJECT";
   });
}

/*
 * Output
 */

function pad(s, len) {
   s = String(s);
   while (s.length < len)
      s += " ";
   return s.substring(0, len);
}

function fmt(v, digits) {
   return isFinite(v) ? v.toFixed(digits) : "-";
}

function printGroup(name, frames) {
   console.writeln("<br/><b>" + name + "</b> (" + frames.length + " frames)");
   console.writeln(pad("File", 44) + " | FWHM  | Ecc  | Stars | Background | Status | Reason");
   frames.forEach(function (f) {
      var status = (f.status == "REJECT") ? "<color=#ff4040>REJECT</color>"
                                          : "<color=#40ff40>OK    </color>";
      console.writeln(pad(f.fileName, 44) + " | " +
                      pad(fmt(f.m.fwhm, 2), 5) + " | " +
                      pad(fmt(f.m.ecc, 2), 4) + " | " +
                      pad(fmt(f.m.stars, 0), 5) + " | " +
                      pad(fmt(f.m.median, 6), 10) + " | " +
                      status + " | " + f.reasons.join(", ") +
                      (f.inRejected ? " (in " + REJECT_FOLDER + ")" : ""));
   });
}

function writeReport(dir, frames) {
   var quote = function (s) { return "\"" + s + "\""; };
   var lines = ["file,group,date_obs,status,location,fwhm,eccentricity,stars,median," +
                "psf_signal_weight,z_fwhm,z_ecc,z_stars,z_median,z_psfsw,reasons"];
   frames.forEach(function (f) {
      lines.push([
         quote(f.path), quote(f.group), f.dateObs, f.status,
         f.inRejected ? REJECT_FOLDER : "main",
         fmt(f.m.fwhm, 3), fmt(f.m.ecc, 3), fmt(f.m.stars, 0),
         fmt(f.m.median, 6), fmt(f.m.psfsw, 6),
         fmt(f.z.fwhm, 2), fmt(f.z.ecc, 2), fmt(f.z.stars, 2),
         fmt(f.z.median, 2), fmt(f.z.psfsw, 2),
         quote(f.reasons.join("; "))
      ].join(","));
   });
   var path = dir + "/" + REPORT_NAME;
   try {
      File.writeTextFile(path, lines.join("\n") + "\n");
      console.writeln("Report written to " + path);
   } catch (e) {
      console.warningln("Could not write report: " + e.message);
   }
}

function message(text, icon) {
   return new MessageBox(text, TITLE, icon, StdButton_Ok).execute();
}

/*
 * Main flow
 */

// Light frames under dir, with the header values used for grouping.
function collectFrames(dir) {
   var frames = [];
   findFiles(dir, [], false).forEach(function (file) {
      var kw = readKeywords(file.path);
      if ((kw["IMAGETYP"] || "LIGHT").toUpperCase().indexOf("LIGHT") < 0)
         return;
      frames.push({
         path: file.path,
         fileName: File.extractNameAndExtension(file.path),
         inRejected: file.inRejected,
         dateObs: kw["DATE-OBS"] || "",
         time: parseDate(kw["DATE-OBS"]),
         airmass: parseFloat(kw["AIRMASS"]),
         group: [kw["OBJECT"] || "?",
                 kw["FILTER"] || "N/A",
                 (kw["EXPTIME"] || kw["EXPOSURE"] || "?") + "s",
                 "G" + (kw["GAIN"] || "?"),
                 "bin" + (kw["XBINNING"] || "1")].join(" | "),
         m: {},
         z: {},
         reasons: [],
         status: "OK"
      });
   });
   return frames;
}

// Moves new rejects into Rejected_Frames and restores frames that now pass.
function applyChanges(toReject, toRestore) {
   var moved = 0, restored = 0;
   toReject.forEach(function (f) {
      var dest = folderOf(f.path) + "/" + REJECT_FOLDER;
      try {
         // No intermediate directories: on a UNC path (//host/share) that
         // walks up to the server root and fails.
         if (!File.directoryExists(dest))
            File.createDirectory(dest, false);
         File.move(f.path, uniqueDestination(dest, f.fileName));
         moved++;
      } catch (e) {
         console.warningln("Could not move " + f.fileName + ": " + e.message);
      }
   });
   toRestore.forEach(function (f) {
      try {
         File.move(f.path, uniqueDestination(folderOf(folderOf(f.path)), f.fileName));
         restored++;
      } catch (e) {
         console.warningln("Could not restore " + f.fileName + ": " + e.message);
      }
   });
   return { moved: moved, restored: restored };
}

function run(dir) {
   console.show();
   console.writeln("<b>" + TITLE + " " + VERSION + "</b>");
   console.writeln("Directory: " + dir);

   var frames = collectFrames(dir);
   if (frames.length == 0) {
      message("No light frames (FITS or XISF) found in the selected directory.", StdIcon_Error);
      return;
   }
   console.writeln(frames.length + " light frames. Measuring with SubframeSelector...");

   var measured;
   try {
      measured = measureFrames(frames.map(function (f) { return f.path; }));
   } catch (e) {
      message(e.message, StdIcon_Error);
      return;
   }
   if (measured.cols.psfsignalweight === undefined)
      console.noteln("PSF signal weight isn't available in this PixInsight version; skipping it.");

   var groups = {};
   frames.forEach(function (f) {
      var m = measured.byPath[pathKey(f.path)];
      if (!m) {
         f.status = "UNMEASURED";
         console.warningln("Not measured, left in place: " + f.fileName);
      } else if (measured.cols.stars !== undefined && !(m.stars > 0)) {
         f.m = m;
         f.status = "REJECT";
         f.reasons.push("No stars detected");
      } else {
         f.m = m;
         (groups[f.group] = groups[f.group] || []).push(f);
      }
   });

   for (var name in groups) {
      var group = groups[name];
      group.sort(function (a, b) {
         if (isFinite(a.time) && isFinite(b.time))
            return a.time - b.time;
         return a.fileName.localeCompare(b.fileName);
      });
      if (group.length < MIN_GROUP)
         console.warningln(name + ": only " + group.length + " frames, too few to judge. Keeping all.");
      else
         scoreGroup(group);
      printGroup(name, group);
   }

   frames.forEach(function (f) {
      if (f.reasons[0] == "No stars detected")
         console.writeln("<color=#ff4040>REJECT</color> " + f.fileName + " | No stars detected");
   });

   writeReport(dir, frames);

   var rejected = frames.filter(function (f) { return f.status == "REJECT"; });
   var toReject = rejected.filter(function (f) { return !f.inRejected; });
   var toRestore = frames.filter(function (f) { return f.status == "OK" && f.inRejected; });

   console.writeln("<br/><b>" + rejected.length + " of " + frames.length + " frames rejected (" +
                   toReject.length + " new, " + toRestore.length + " to restore).</b>");
   toRestore.forEach(function (f) { console.writeln("Restore: " + f.fileName); });

   if (toReject.length == 0 && toRestore.length == 0) {
      message(rejected.length + " of " + frames.length + " frames rejected, all already in " +
              REJECT_FOLDER + ". Nothing to change.", StdIcon_Information);
      return;
   }

   var question = rejected.length + " of " + frames.length + " frames rejected.\n";
   if (toReject.length > 0)
      question += "Move " + toReject.length + " new reject(s) to " + REJECT_FOLDER + ".\n";
   if (toRestore.length > 0)
      question += "Restore " + toRestore.length + " frame(s) that now pass.\n";
   question += "\nReasons are in the console and " + REPORT_NAME + ".\n\nApply these changes?";

   if (new MessageBox(question, TITLE, StdIcon_Question, StdButton_Yes, StdButton_No).execute() != StdButton_Yes) {
      console.writeln("No files moved.");
      return;
   }

   var result = applyChanges(toReject, toRestore);
   var summary = "Moved " + result.moved + " frame(s) to " + REJECT_FOLDER +
                 ", restored " + result.restored + ".";
   console.writeln(summary);
   message(summary, StdIcon_Information);
}

/*
 * Dialog
 */

function SmartSorterDialog() {
   this.__base__ = Dialog;
   this.__base__();

   this.windowTitle = TITLE + " " + VERSION;
   this.minWidth = 420;

   this.info = new Label(this);
   this.info.wordWrapping = true;
   this.info.text = "Measures every light frame with SubframeSelector and rejects outliers in " +
                    "FWHM, eccentricity, star count, background and PSF signal weight, using " +
                    "limits taken from the session itself. Subfolders are included. Frames " +
                    "already in " + REJECT_FOLDER + " are checked again and restored if they " +
                    "pass. Nothing is moved until you confirm.";

   this.dirLabel = new Label(this);
   this.dirLabel.text = "Lights directory:";

   this.dirEdit = new Edit(this);
   this.dirEdit.readOnly = true;
   var saved = Settings.read(SETTINGS_KEY + "/directory", DataType_String);
   if (Settings.lastReadOK && saved)
      this.dirEdit.text = saved;

   this.dirButton = new ToolButton(this);
   this.dirButton.icon = this.scaledResource(":/icons/select-file.png");
   this.dirButton.toolTip = "Select the lights directory";
   this.dirButton.onClick = function () {
      var d = new GetDirectoryDialog;
      d.caption = "Select lights directory";
      if (this.dialog.dirEdit.text)
         d.initialPath = this.dialog.dirEdit.text;
      if (d.execute())
         this.dialog.dirEdit.text = d.directory;
   };

   this.dirSizer = new HorizontalSizer;
   this.dirSizer.spacing = 4;
   this.dirSizer.add(this.dirEdit, 100);
   this.dirSizer.add(this.dirButton);

   this.okButton = new PushButton(this);
   this.okButton.text = "Analyze";
   this.okButton.onClick = function () {
      if (this.dialog.dirEdit.text == "") {
         message("Select a directory first.", StdIcon_Error);
         return;
      }
      this.dialog.ok();
   };

   this.cancelButton = new PushButton(this);
   this.cancelButton.text = "Cancel";
   this.cancelButton.onClick = function () {
      this.dialog.cancel();
   };

   this.buttons = new HorizontalSizer;
   this.buttons.spacing = 6;
   this.buttons.addStretch();
   this.buttons.add(this.okButton);
   this.buttons.add(this.cancelButton);

   this.sizer = new VerticalSizer;
   this.sizer.margin = 12;
   this.sizer.spacing = 8;
   this.sizer.add(this.info);
   this.sizer.addSpacing(8);
   this.sizer.add(this.dirLabel);
   this.sizer.add(this.dirSizer);
   this.sizer.addSpacing(16);
   this.sizer.add(this.buttons);

   this.adjustToContents();
}

SmartSorterDialog.prototype = new Dialog;

function main() {
   var dialog = new SmartSorterDialog;
   if (!dialog.execute())
      return;
   var dir = dialog.dirEdit.text;
   Settings.write(SETTINGS_KEY + "/directory", DataType_String, dir);
   run(dir);
}

main();
