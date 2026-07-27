# pi-codecraft

A rich Pi extension that replaces built-in search and edit tools with precise, guardrailed utilities.

## What it adds

| Tool | Purpose |
|------|---------|
| `rg` | Fast content search with ripgrep (replaces built-in `grep`) |
| `fd` | Fast file/directory discovery (replaces built-in `find` / `ls -R`) |
| `ast_grep` | Structure-aware code search and rewrite via [ast-grep](https://astgrep.com/) |
| `format_file` | Auto-format code with Prettier or Biome |
| `git_status` | Concise repo status + diff stat before finishing |
| `trash` | Move files/folders to `/tmp` instead of deleting them |
| `quick_edit` / `target_edit` | Line-number and marker-based editing via built-in `fast-edit` logic (replaces built-in `edit`) |

## Guardrails

- **Deletes are blocked.** Any `bash` command containing `rm`, `rm -rf`, `rmdir`, `unlink`, or `shred` is rejected before it runs.
- The model is told to use the `trash` tool, which moves the item to a unique `/tmp/pi-trash-XXXXXX/<original-absolute-path>` location (like a recycle bin).
- Non-standard patterns (`grep`, `find .`, `apply_patch` in bash) trigger a warning.
- System-prompt rules guide the model to prefer the custom tools.

## Requirements

- Node.js 20+
- `rg` (ripgrep), `fd` (or `fdfind`), `ast-grep` (or `sg`), `git`, and optionally Prettier / Biome on `PATH`
- No extra npm package is required for the editing tools; `fast-edit.ts` is self-contained.

## Usage

Run once:

```bash
pi -e /workspaces/pi-standard-tools/extension.ts
```

Install globally so it loads automatically:

```bash
mkdir -p ~/.pi/agent/extensions
cp /workspaces/pi-standard-tools/extension.ts ~/.pi/agent/extensions/standard-tools.ts
cp /workspaces/pi-standard-tools/fast-edit.ts ~/.pi/agent/extensions/fast-edit.ts
```

Then start Pi normally in any project.
