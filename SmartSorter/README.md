# Smart Sorter

Finds and sets aside bad light frames after an imaging session. It measures
every frame with PixInsight's SubframeSelector and rejects the ones that are
clearly worse than the rest of the night: clouds, trailing, lost focus,
obstructions, dawn.

There are no tolerances to set. The limits come from the session itself, so
the same script works on a steady night and a patchy one without tweaking.

Tested with FITS files from N.I.N.A. 3.2 on PixInsight for Windows, including
data on a network share (NAS).

## Usage

1. Run **Script > Utilities > Smart Sorter**.
2. Pick the folder with the light frames. Subfolders are included, so this can
   be a single target, a whole night, or a filter folder.
3. Click **Analyze**.

The script prints a table per group in the console, writes
`SmartSorter_report.csv` into the selected folder, and then shows what it
wants to change:

```
15 of 67 frames rejected.
Move 1 new reject(s) to Rejected_Frames.
Restore 1 frame(s) that now pass.

Apply these changes?
```

Nothing is moved until you click **Yes**. Rejected frames go into a
`Rejected_Frames` folder next to the frame, never deleted.

Running it again on the same folder is safe. Frames already in
`Rejected_Frames` are measured again along with the rest, so the result is the
same every time, and a frame that no longer fails (for example after a change
to the script) is offered back.

## How frames are judged

### Groups

Frames are only compared with similar frames. A group is the same object,
filter, exposure, gain and binning, read from the FITS header. Groups with
fewer than 5 frames are left alone, since there isn't enough data to say what
normal is.

Frames with `IMAGETYP` other than `LIGHT` are skipped, so flats or darks in the
same tree are ignored.

### Metrics

From SubframeSelector:

| Metric | Worse when | Typical cause |
|---|---|---|
| FWHM | higher | focus drift, seeing, wind |
| Eccentricity | higher | trailing, guiding errors, wind |
| Stars | lower | cloud, haze, obstruction |
| Background (median) | higher | cloud lit by city lights, moon, dawn |
| PSF signal weight | lower | overall quality, combines the above |

FWHM, star count, background and PSF signal weight are compared as ratios
(on a log scale), so a 10% change counts the same whether the value is small or
large. Eccentricity is compared as a plain difference.

A frame where SubframeSelector finds no stars at all is rejected outright.

### Two checks per metric

Each metric gets two separate checks, and a frame is rejected if either one
fails for any metric.

**Against neighbouring frames.** A straight line is fitted through the nearest
frames in time (3 to 10 on each side depending on the session length, not
counting the frame itself), and the frame is compared with where that line
says it should be. This catches short events: a passing cloud, a gust, a
single trailed frame. A line is used rather than an average of the neighbours
because at the start and end of a session all the neighbours are on one side;
if conditions are drifting, an average would make the last few frames look
worse than they are.

Limit: 3 sigma.

**Against the airmass trend.** A straight line is fitted through the whole
group against airmass (from the `AIRMASS` header). As a target sinks,
extinction and sky glow make stars fainter and the background brighter in a
fairly smooth way, so frames at high airmass aren't penalised for being
lower. What this catches is a stretch that departs from that trend: a cloud
bank or an obstruction that lasts longer than the neighbour window and would
otherwise look normal compared to its equally bad neighbours. The fit ignores
outliers (3-sigma clipping), so the bad stretch doesn't drag the line with it.
If any frame is missing `AIRMASS`, time is used instead.

Limit: 4 sigma.

### Sigma

The spread for each check is measured from the group using the median
absolute deviation, which isn't thrown off by the bad frames it's trying to
find. On a steady night the spread is small and the limits are tight; on a
variable night they widen on their own.

Each metric also has a minimum spread so that a very consistent night doesn't
reject frames over differences nobody would notice:

| Metric | Minimum spread |
|---|---|
| FWHM | 3% |
| Eccentricity | 0.04 |
| Stars | 5% |
| Background | 2% |
| PSF signal weight | 5% |

These, and the 3 and 4 sigma limits, are constants at the top of the script.
They were chosen by testing on several nights of real data and aren't meant to
be tuned per session.

## Report

`SmartSorter_report.csv` has one row per frame:

| Column | Meaning |
|---|---|
| `file` | full path |
| `group` | object, filter, exposure, gain, binning |
| `date_obs` | `DATE-OBS` from the header (UTC) |
| `status` | `OK`, `REJECT` or `UNMEASURED` |
| `location` | `main` or `Rejected_Frames`, where the file was when the script ran |
| `fwhm` ... `psf_signal_weight` | SubframeSelector measurements |
| `z_fwhm` ... `z_psfsw` | how many sigmas worse than expected; positive is worse, the larger of the two checks |
| `reasons` | why the frame was rejected |

The `z_` columns are useful for spotting frames that were close to the limit.

## What it doesn't do

- It doesn't decide how many frames are worth stacking. A slow decline in
  quality through the night (target getting lower, sky getting brighter) is
  treated as normal, and those frames are kept. Weighting in ImageIntegration
  (PSF signal weight) already gives them less influence.
- It measures uncalibrated frames. SubframeSelector warns about this for every
  file; it doesn't matter here because frames are only compared with each
  other, not judged against absolute values.
- It doesn't look at the image content, so something like a satellite trail
  that leaves the stars intact won't be caught. Pixel rejection during
  integration handles those.

## Troubleshooting

**"Unrecognised SubframeSelector measurements layout"**
The column names in SubframeSelector's results changed in a new PixInsight
version. Nothing was moved. The console shows the column list and the values
for one frame; the names the script looks for are in the `METRICS` table at the
top of the script (`fwhm`, `eccentricity`, `stars`, `median`,
`psfsignalweight`, plus `path` or `filePath`).

**"Not measured, left in place"**
SubframeSelector couldn't process that file. It is kept, not rejected.

**A group says "too few frames to judge"**
Fewer than 5 comparable frames. Check the group name in the console; a
different gain or exposure in the header puts frames in separate groups.
