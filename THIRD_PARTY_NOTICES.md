# Third-Party Notices

Portions of the page-context Apollo operation-capture pattern in
`extension/src/main-world.ts` are adapted from the capture/link wrapping
implementation in <https://github.com/chrischall/fetchproxy>. Availability
request field names in `extension/src/content.ts` were informed by
<https://github.com/chrischall/opentable-mcp>.

The Phase 2 `/booking/details` initial-state extraction pattern and selected
booking-term field paths were adapted from `chrischall/opentable-mcp`. Phase 3
adapts the Standard slot-lock persisted-query operation, signed-in profile
field paths, and make-reservation request field sequence from that project at
revision `b99c13cd43b5e670e3020da3f740d6f4311c4fe2`. OpenTableBot independently
adds its capability boundary, strict bridge schemas, post-lock revalidation,
sanitization, conservative expiry, and terminal exactly-once outcome model.

Copyright (c) 2026 Chris Hall

Both referenced projects were published under the MIT License when reviewed:

Permission is hereby granted, free of charge, to any person obtaining a copy of
this software and associated documentation files (the "Software"), to deal in
the Software without restriction, including without limitation the rights to
use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
the Software, and to permit persons to whom the Software is furnished to do so,
subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
