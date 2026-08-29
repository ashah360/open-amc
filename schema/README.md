# AMC GraphQL schema

`amc.graphql` is the pinned SDL contract returned by AMC's public GraphQL
federation `_service.sdl` surface. It is retained for contract review, code
navigation, and drift comparison; runtime requests do not load it.

Refresh deliberately with a read-only authenticated transport, review the diff,
and run the full verification suite. Never commit the response envelope,
headers, cookies, session state, or request captures alongside the SDL.
