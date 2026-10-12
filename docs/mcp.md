# The MCP server

SocialMonitor ships an MCP server, so Claude can read your data and run updates from any chat. It calls the dashboard's local API, so the dashboard must be running (`yarn start`).

## Connect Claude Code

```bash
claude mcp add socialmonitor --scope user -- node /path/to/SocialMonitor/apps/app/src/mcp/main.ts
```

Use Node 22.18 or newer. `SOCIALMONITOR_URL` changes the address (default `http://127.0.0.1:4400`).

## Tools

| Tool         | What it does                                                                 |
| ------------ | ---------------------------------------------------------------------------- |
| `overview`   | Brands, comment counts by label, freshness of each network. Start here.      |
| `comments`   | Comments as `id\|network\|label\|reply\|likes\|author\|text` lines, filtered |
| `posts`      | Recent posts with counts and what each one is about                          |
| `update`     | Starts an update; returns its id                                             |
| `run_status` | Progress of an update                                                        |
| `report`     | The report of an update                                                      |
| `relabel`    | Corrects the AI's label on a comment                                         |
| `kinds`      | A brand's positive and negative kinds of comment                             |
| `rate`       | Rates comments positive or negative, with a kind, as Claude                  |
| `add_brand`  | Adds a brand with its profile links                                          |
| `schedules`  | Lists, sets or deletes schedules                                             |

Answers are compact text lines rather than JSON, to keep each call small.
