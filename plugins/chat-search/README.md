# EzDSH Chat Search

This bundled DSH plugin adds indexed, conversation-wide search to the Chat view. `Cmd+F` on macOS and `Ctrl+F` elsewhere open the search panel; Enter and Shift+Enter move between matches.

The Host half searches the current Session through `sessionQuery.searchEvents`, restricts results to visible message and tool events, resolves each event to the stable Chat node key used by the pinned DSH Runtime, deduplicates shared tool rows, and returns matches in transcript order. The Client half loads older history through the Session model before scrolling to and highlighting the selected Chat node.

Search uses DSH's FTS5 `unicode61` token/phrase semantics rather than arbitrary substrings. Assistant reasoning is intentionally excluded by the upstream semantic extractor.

The plugin is mounted through EzDSH's additional Runtime patch and enables the Web profile's deferred in-memory full-text index on first search. Its exact POST route uses the same authenticated `/api` boundary as DSH Web. Search state is presentation-only and does not enter the Session log or model context.
