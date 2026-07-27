# Pi CodeCraft — Search & Edit Workflow

> Effective immediately for all coding sessions unless overridden by the user.

## 1. Search / Discovery

Never use plain `grep`. Prefer the tools below in this order:

| Need | Tool | When to use |
|---|---|---|
| Find files or directories | `fd` | List files, filter by extension, find directories. |
| Fast text / regex search | `rg` (ripgrep) | Search symbols, imports, strings, exact patterns. |
| Conceptual / natural-language search across a repo | `semble` | Query like “how is authentication handled?”. |
| AST-aware code search | `ast-grep` | Structural patterns on supported languages. |

### Common commands

```bash
# fd
fd -e ts . path/                 # all .ts files
fd 'filename' path/              # by name
fd -t d 'name' path/             # directories
fd -H pattern path/              # include hidden files

# rg
rg 'pattern' path/               # search
rg -t py 'pattern' path/         # python only
rg -C 3 'pattern' path/          # 3 lines context
rg -l 'pattern' path/            # list matching files
rg -g '!*test*' 'pattern' path/  # ignore test files

# semble
semble search "authentication flow" ./my-project
semble search "save model to disk" ./my-project --top-k 10
semble search "deployment guide" ./my-project --content docs   # code | docs | config | all
semble find-related src/auth.py 42 ./my-project

# ast-grep (search only)
ast-grep run -p 'console.log($A)' src/
```

## 2. Edit

Choose the highest tool that can make the change reliably.

| Condition | Tool | Command |
|---|---|---|
| Supported language + valid AST pattern | **`ast-grep`** | `ast-grep run -p '<pattern>' -r '<fix>' -U <path>` |
| `ast-grep` fails (syntax errors, unsupported language, invalid pattern) | **`comby`** | `comby '<match>' '<replacement>' -in-place <file>` |
| $~~~~~~~$`ast-grep` and `comby` both fail, or the file is plain text / config where AST tools do not apply | **`fast-edit`** | Pi extension tool using `snap-edit` logic |

> `fast-edit` should only be used after `ast-grep` and `comby` cannot handle the edit. It is the final fallback, not the first choice. For Markdown or other non-code text, it is acceptable to skip `ast-grep` and go directly to `fast-edit`.

### ast-grep

```bash
# One-shot rewrite
ast-grep run -p 'return $B;' -r 'return $B + 1;' -U src/

# YAML rule scan
ast-grep scan -r rule.yml -U src/

# Debug pattern
ast-grep run -p '...' --debug-query=ast -l ts src/
```

Key syntax:
- `$VAR` = one AST node
- `$$$VAR` = zero or more AST nodes
- Captured metavariables (`$A`) must match literally across the pattern.
- Without `-U`, ast-grep only prints a diff.

### comby

```bash
# In-place edit
comby ':[FUNC](:[ARGS])' ':[FUNC](:[ARGS], extra)' -in-place file.js

# Short form
comby ':[FUNC](:[ARGS])' ':[FUNC](:[ARGS], extra)' -i file.js

# Stdin
comby 'swap(:[1], :[2])' 'swap(:[2], :[1])' -stdin .js <<< 'swap(x, y)'
```

Key syntax:
- `:[NAME]` = hole / metavariable
- `:[_]` = anonymous / non-capturing hole

## 3. Format

After editing, format the file if a formatter is available.

1. Detect repo-local formatter from:
   - `biome.json`, `.prettierrc*`, `prettier.config.*`
   - `package.json` devDependencies

2. Repo-local commands:
```bash
npx prettier --write <file>
cd /path/to/project && npx @biomejs/biome format --write <file>
```

3. Fallback to global tools in `/home/agent/.hermes/tools`:
```bash
npx --prefix /home/agent/.hermes/tools prettier --write <file>
cd /home/agent/.hermes/tools && npx @biomejs/biome format --write <file>
```

Do not install a new formatter if the project does not already use one.

## 4. Decisions to avoid

- Do not use `grep`.
- Do not use `comby` when `ast-grep` works fine (less precise).
- Do not force `ast-grep` on unsupported languages when `comby` or `fast-edit` can handle it.
- Do not use `fast-edit` unless both `ast-grep` and `comby` fail.
- Do not skip formatting when the repo already has a formatter configured.

## 5. Installed tools on this host

| Tool | Version | Location / notes |
|---|---|---|
| `rg` | 15.1.0 | `/usr/bin/rg` |
| `fd` | 10.4.2 | `/usr/bin/fd` |
| `ast-grep` | 0.45.0 | `/home/agent/.local/bin/ast-grep` |
| `comby` | 1.7.0 | `/usr/local/bin/comby` (requires `libpcre.so.3` symlink) |
| `prettier` | 3.9.6 | `/home/agent/.hermes/tools/node_modules/.bin/prettier` |
| `biome` | 2.5.5 | `/home/agent/.hermes/tools/node_modules/.bin/biome` |
| `semble` | latest | `/home/agent/.local/bin/semble` (uv tool) |

## 6. Detailed reference

For full command reference, stability tips, and decision tree, load the Hermes skill:

```text
~/.hermes/skills/dev/code-editing-toolkit/SKILL.md
```

Or call from a Hermes session:
```text
/load skill code-editing-toolkit
```
