# ima2-gen-mcp

MCP adapter for `lidge-jun/ima2-gen`.

The adapter does not reimplement image generation. It calls the local `ima2-gen` HTTP API exposed by `ima2 serve`, so the web UI and MCP tools can use the same local server, auth, history, and generated image folder.

## 1. Install and configure ima2-gen

```bash
node -v
npm install -g ima2-gen
ima2 setup
ima2 serve
```

Or without global install:

```bash
npx ima2-gen serve
```

Open the web UI at the URL printed by `ima2 serve`. The default is usually `http://localhost:3333`, but ima2-gen may fall back to another port and writes the actual URL to `~/.ima2/server.json`.

## 2. Install this MCP adapter

```bash
cd ima2-gen-mcp
npm install
npm run build
```

## 3. MCP client config

Use an absolute path to `build/index.js`.

```json
{
  "mcpServers": {
    "ima2-gen": {
      "command": "node",
      "args": ["/ABSOLUTE/PATH/ima2-gen-mcp/build/index.js"],
      "env": {
        "IMA2_MCP_AUTO_START": "1"
      }
    }
  }
}
```

`IMA2_MCP_AUTO_START=1` lets the MCP adapter start `npx ima2-gen serve` if the server is not already running. For the first login/setup, run `ima2 setup` or `npx ima2-gen serve` manually in a terminal first.

## Tools

- `ima2_status`: checks local server health/provider status.
- `ima2_generate`: calls `POST /api/generate`.
- `ima2_edit`: calls `POST /api/edit`.

Generated files are saved by ima2-gen, usually under `~/.ima2/generated`.

## Useful environment variables

- `IMA2_SERVER`: explicit server URL, for example `http://localhost:3334`.
- `IMA2_CONFIG_DIR`: config directory, default `~/.ima2`.
- `IMA2_ADVERTISE_FILE`: server discovery file, default `~/.ima2/server.json`.
- `IMA2_GENERATED_DIR`: generated image directory, default `~/.ima2/generated`.
- `IMA2_MCP_AUTO_START`: set `1` to auto-start `npx ima2-gen serve`.
- `IMA2_MCP_SERVE_COMMAND`: override command used for auto-start.
- `IMA2_MCP_SERVE_ARGS`: override args used for auto-start, for example `ima2 serve --dev`.

## Git ignored local files

Do not commit real environment files, local MCP client config, generated output, or dependency/build artifacts. The `.gitignore` excludes `.env` and `.env.*`, `claude_desktop.json`, `node_modules/`, `build/`, logs, and local ima2-gen state/output.

Commit only safe templates such as `.env.example` or `claude_desktop.example.json`, and keep secrets, provider credentials, local paths, and generated images in your local machine-specific files.
