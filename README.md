# Kiseki Texthooker

A local browser texthooker that pairs captured Japanese with the corresponding English localization from Trails in the Database. The Japanese remains selectable for Yomitan while lookup runs.

## Run it

Requires Node.js 22 or later. There are no packages to install.

```text
npm start
```

Open [http://127.0.0.1:8765](http://127.0.0.1:8765) in the browser where you use Yomitan. Stop the server with `Ctrl+C`. If the port is taken, set the `PORT` environment variable before starting and use the address printed in the terminal. On Windows, `npm.cmd start` also works in PowerShell.

1. Start Agent or LunaTranslator and enable its WebSocket service.
2. Choose the source in the texthooker, check its address, and click **Connect**. The suggested Agent port is `9001`. For LunaTranslator, use its configured port and keep `/api/ws/text/origin` in the URL.
3. Choose the game you are playing. New lines appear as soon as they arrive. When the matching localization is found, it appears beneath the Japanese. Use Yomitan on the Japanese text as you would on another webpage.

The browser reads from the source on your machine. The Node server sends game-scoped text queries to Trails in the Database. The reading log is kept in the browser tab for the current session.

## Matching and checks

The prototype compares the full captured Japanese against the database dialogue, ignoring whitespace and ruby readings for matching. It keeps the captured text as received. It leaves English blank for partial lines, multiple candidate rows, and search results that hit the result limit. Some lines can still go unmatched when extraction and database formatting differ.

Run `npm test` for the capture parser and matching checks.

- [LunaTranslator network service](https://docs.lunatranslator.org/en/apiservice.html#websocket-service)
- [Agent](https://github.com/0xDC00/agent)
- [Trails in the Database](https://trailsinthedatabase.com/)
- [Yomitan](https://yomitan.wiki/)
