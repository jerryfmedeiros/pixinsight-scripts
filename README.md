# PixInsight scripts

PJSR scripts I use to process my astrophotography data in PixInsight.

| Script | Menu | What it does |
|---|---|---|
| [SmartSorter](SmartSorter/README.md) | Script > Utilities > Smart Sorter | Rejects bad light frames using limits derived from each session's own statistics |

## Installing

The simplest way is to register this folder as a feature scripts directory so
every script shows up in the Script menu:

1. Clone the repository somewhere PixInsight can see it.
2. In PixInsight, open **Script > Feature Scripts...**
3. Click **Add**, select the repository folder and click **Done**.

PixInsight scans subfolders for `#feature-id` lines, so new scripts appear
after repeating **Script > Feature Scripts... > Done**.

A single script can also be run directly with **Script > Run Script File...**

## Layout

```
<ScriptName>/
    <ScriptName>.js     the script
    README.md           documentation
tools/
    check.sh            syntax check that mimics the PJSR preprocessor
```

Each script lives in its own folder with its documentation next to it.

## Checking scripts before running them

```sh
tools/check.sh                 # every script in the repo
tools/check.sh Foo/Foo.js      # one script
```

Needs Node.js. It catches the one PJSR quirk that plain JavaScript tools miss:
the preprocessor treats a double slash as the start of a comment anywhere on a
line, including inside strings and regular expressions. Code like
`"http://..."` or `/\/\//` is valid JavaScript but gets cut in half by
PixInsight.

## Notes for writing new scripts

- PJSR is an older JavaScript engine. Stick to ES5: `var`, `function`, no
  arrow functions, no template strings.
- Keep a double slash out of any code line (see above). Build it with
  `"/" + "/"` if you need it in a string.
- On Windows network shares (`//host/share/...`),
  `File.createDirectory(path)` fails because it tries to create every parent
  up to the server. Use `File.createDirectory(path, false)` for a single
  folder.
- Read FITS headers with `FileFormatInstance` instead of opening an
  `ImageWindow`; it doesn't load the pixel data and is much faster.
- Anything that moves or deletes files should show what it's about to do and
  ask first.
