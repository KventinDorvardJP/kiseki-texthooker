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
3. Choose the game you are playing. New lines appear at the top. When the matching localization is found, it appears beneath the Japanese with the English speaker name if available. Use Yomitan on the Japanese text as you would on another webpage.

The browser reads from the source on your machine. The Node server sends game-scoped text queries to Trails in the Database. The reading log keeps the latest 20 entries in the browser tab.

Check **Hide English localization** beside **Clear log** to read in Japanese while lookups run. Uncheck it to show English already found for entries still in the log.

## Matching and checks

The prototype can search using part of the capture, then compares the full captured Japanese against the database dialogue. The comparison ignores whitespace, ruby readings, digit width, and dialogue dashes at line endings. It also treats Japanese ellipses and runs of three or more periods as equivalent. The reading log keeps the Japanese as received.

Trails of Cold Steel III entries can span multiple dialogue boxes. When a capture matches a complete box and TITDB preserves the same box structure in both languages, the app shows that box’s English. Incomplete boxes, ambiguous matches, and searches that hit the result limit leave English blank.

Several matches can agree on the same English line and speaker. For Agent, the immediately previous capture can resolve conflicting matches in Cold Steel III within one TITDB entry or across two consecutive entries in the same scene and script. Across entries, the captured text must match the end of the previous entry and the start of the current one. The app resets that context when you change games, disconnect, or clear the log. Each LunaTranslator OCR capture is matched independently.

When Agent has no matching context, a single complete Cold Steel III entry can supply the English if its textbox alternatives share the captured speaker and differ only in the length of a repeated letter in an uppercase exclamation.

When Agent puts the speaker on the first line, the matcher can ignore that line for dialogue comparison if it matches the candidate’s Japanese speaker name.

For Cold Steel III Agent captures, the matcher interprets the single character `㈱` as the game’s heart glyph `♥` during lookup. The reading log keeps the captured character.

Notes and stars such as `♪`, `☆`, and `★` are compared as written, including in Cold Steel III dialogue wrapped in a TITDB voice link.

Run `npm test` for the capture parser and matching checks.

- [LunaTranslator network service](https://docs.lunatranslator.org/en/apiservice.html#websocket-service)
- [Agent](https://github.com/0xDC00/agent)
- [Trails in the Database](https://trailsinthedatabase.com/)
- [Yomitan](https://yomitan.wiki/)
