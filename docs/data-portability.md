# GraphVault Data Portability

> "Your data, any storage." - Export the whole vault at any time to plain,
> readable files. Import from any standard archive.

GraphVault ships two interchange formats and an import pipeline that is
hardened as a security boundary. Everything runs entirely in the browser - no
file leaves your device during export or import.

## Export formats

### Markdown ZIP

The default export and the recommended long-term archive format.

- A standard `.zip` archive using the **STORE method** (no compression). The
  absence of compression keeps the writer dependency-free and makes the file
  round-trip byte-for-byte through any standard unzip tool.
- The ZIP central directory records the note's last-modified timestamp (DOS
  date/time derived from `note.mtime`).
- Folder structure is preserved. A note at path `projects/ideas.md` appears
  inside the ZIP at that exact path.
- The exported file is named `graphvault-<YYYY-MM-DD-HHmm>.zip`.

To recover from the archive outside of GraphVault: unzip it. The result is a
plain folder of `.md` files, readable in any text editor or Markdown app.

### JSON backup

A single versioned JSON file containing all notes.

```jsonc
{
  "format": "graphvault-vault",
  "version": 1,
  "exportedAt": 1718467200000,
  "notes": [
    {
      "path": "projects/ideas.md",
      "content": "# Ideas\n\nSee [[Sync]].",
      "ctime": 1718000000000,
      "mtime": 1718467000000,
    },
  ],
}
```

- The `format` and `version` fields identify the envelope. The version is
  bumped only on a breaking shape change.
- The exported file is named `graphvault-<YYYY-MM-DD-HHmm>.json`.
- Handy for scripting, migration, or as a one-file backup alongside the ZIP.

## Import

### Accepted file types

| Extension                  | Handling                                                           |
| -------------------------- | ------------------------------------------------------------------ |
| `.zip`                     | Central-directory parsed; STORE and DEFLATE entries both supported |
| `.json`                    | Parsed as a GraphVault JSON envelope                               |
| `.md`, `.markdown`, `.txt` | Treated as a single note; the filename becomes the vault path      |

### The never-overwrite guarantee (conflict copies)

Import **never silently replaces an existing note**. For each incoming note:

- If no note exists at that path, the note is added as-is.
- If a note exists at that path with **identical content**, it is skipped
  (unchanged count).
- If a note exists at that path with **different content**, the incoming note
  is saved at a renamed path: `<stem> (imported copy).<ext>`. This is reported
  as a "renamed" entry in the import summary.

The result is that your current notes are always preserved and the import
result is always fully visible - never a silent overwrite.

### Import report

After import the app shows a summary:

```
Imported: 12 added, 2 kept as copies (no overwrite), 5 unchanged.
```

### Security guards

Importing an untrusted archive is a security boundary. The following guards
are enforced before any content is written:

| Guard                   | Limit                          | Purpose                                                                               |
| ----------------------- | ------------------------------ | ------------------------------------------------------------------------------------- |
| Zip-slip path rejection | -                              | Rejects absolute paths, `..` traversal segments, Windows drive letters, and UNC paths |
| Extension allowlist     | `.md`, `.markdown`, `.txt`     | Non-text files (images, executables) are silently skipped                             |
| Per-file size cap       | 4 MiB                          | Oversized entries are skipped without aborting the rest of the import                 |
| Aggregate size cap      | 64 MiB                         | Stops processing and returns an error if the running total exceeds the limit          |
| File count cap          | 10 000                         | Checked against the ZIP central directory before any data is read                     |
| Compression method      | STORE (0) and DEFLATE (8) only | Entries with unsupported compression are skipped                                      |

These limits guard against zip-bomb / OOM attacks from a maliciously crafted
archive. The caps are defined as named constants in
`apps/web/lib/vault/portability.ts` (`MAX_IMPORT_FILE_BYTES`,
`MAX_IMPORT_TOTAL_BYTES`, `MAX_IMPORT_FILES`).

### Path normalisation

All paths go through `safeImportPath()` before use. The function:

1. Rejects the path if it is not a string, is empty, starts with `/` or `\`,
   matches a Windows drive letter (`C:\…`), or is a UNC path (`\\…`).
2. Normalises separators and removes redundant segments via `normalizePath()`.
3. Rejects the result if any segment equals `..`.
4. Rejects the path if its lowercased extension is not in the allowlist.

A rejected path is silently skipped; the rest of the archive continues to
import.

## ZIP reader: STORE vs. DEFLATE

GraphVault writes ZIPs with the STORE method (compression method `0`) for
maximum portability and zero dependencies. When reading, it also handles DEFLATE
(method `8`) so standard ZIP archives produced by other tools - including OS
"compress to zip" dialogs - can be imported. Decompression uses the platform's
native `DecompressionStream('deflate-raw')` API, which is available in all
modern browsers. Entries compressed with any other method are skipped with a
warning rather than aborting the import.

The reader parses the **central directory** (the authoritative file list at the
end of the archive) rather than scanning local headers. This is both faster and
more robust against malformed or partially-downloaded archives.

## Round-trip fidelity

- **Content**: exact byte-for-byte round-trip for Markdown text (UTF-8, no
  line-ending normalisation in v0).
- **Timestamps**: `mtime` is preserved in the JSON format. The ZIP format
  preserves `mtime` in the DOS date/time field (2-second resolution, local
  time). `ctime` is preserved only in JSON.
- **Folder structure**: preserved in both formats via the vault-relative path.
- **`[[wikilinks]]` and `#tags`**: plain text in the `.md` content;
  re-indexed automatically when the vault loads after import.

## Server-proxied cloud storage targets

Beyond local export/import, the self-hosted server can keep a copy of the whole
vault (a single `graphvault-vault.json` blob) in an external object store -
**without the browser ever seeing the provider credentials**. Supported backends:
S3-compatible, WebDAV, **Azure Blob Storage**, and **Google Cloud Storage**. The
blob is plain JSON (the same shape as the JSON backup above), so the vault stays
portable: you can download it from the provider and re-import it anywhere. The
server stores each provider's credentials encrypted at rest and proxies exactly
one object - see `apps/server/README.md` for the per-provider setup.

## Planned

- **Drag-and-drop import** onto the settings page.
- **"Export to folder"** via the File System Access API where the browser
  supports it (writes individual `.md` files directly to a chosen folder on
  disk, without the ZIP wrapper).
