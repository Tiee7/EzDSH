# Mobile remote experience QA

## Comparison target

- Source visual truth: `/Users/snake/.codex/visualizations/2026/08/29/01a04d38-7e83-7033-8c53-830d5067efd2/mobile-reference-phone-crop.png`
- Implementation screenshot: `/Users/snake/.codex/visualizations/2026/08/29/01a04d38-7e83-7033-8c53-830d5067efd2/mobile-reference-implementation-full.png`
- Full-view comparison: `/Users/snake/.codex/visualizations/2026/08/29/01a04d38-7e83-7033-8c53-830d5067efd2/mobile-reference-comparison.png`
- Viewport: `393 × 852` CSS px, device scale factor `1`.
- Source pixels: `210 × 450`; normalized to `393 × 852` for the side-by-side comparison. The source is a cropped marketing photo containing a device bezel and browser chrome, while the implementation capture is the page content only.
- Implementation pixels: `393 × 852`; no density scaling applied.
- State: connected conversation with a user prompt, completed assistant response, collapsed reasoning/tool activities, and the bottom composer.

## Evidence and checks

- Full-view comparison confirms the intended two-layer conversation hierarchy: app/connection status, a back-and-title toolbar, compact user bubble, full-width assistant reading area, collapsible activity rows, and a fixed bottom composer.
- A separate focused crop was not useful: the reference is only a `210 × 450` photo and its text/icon detail is already below reliable comparison resolution. The full comparison remains readable at the normalized target size.
- Fonts and typography: the implementation uses the platform system stack with a clear title/body/small-status hierarchy. Long conversation text wraps without clipping.
- Spacing and layout rhythm: the content stays within the `393px` phone width; the toolbar and composer remain fixed and separated from scrollable message content.
- Colors and tokens: white reading surface, neutral user bubble, dark primary action, and green connected state match the reference's restrained mobile treatment.
- Image and icon fidelity: the product logo is served from the existing app asset; interaction icons come from the Font Awesome library rather than custom-drawn SVGs.
- Copy: pairing, connection, session, activity, and composer labels are coherent in Chinese and have an English locale path.
- Primary interactions checked in the browser: automatic opening of the newest session, returning to the session list, reopening a session, sending a prompt, and stopping a running task.
- Console check: no warnings or errors for the final live preview URL (`qa=live`).

## Comparison history

1. [P2, resolved] The first conversation capture hid the app/connection strip while the source made connection context visible above the conversation toolbar.
   - Fix: retained the compact app header in the chat state and preserved the connected status indicator.
   - Post-fix evidence: `mobile-reference-implementation-full.png` and `mobile-reference-comparison.png` show the visible app name and green connection state above the back/title row.

## Findings

No actionable P0, P1, or P2 differences remain. The source device frame, Safari chrome, and unrelated conversation copy are expected differences rather than product UI drift. A pointer visible in the implementation screenshot is browser-capture chrome and is excluded from the comparison.

## Follow-up polish

- [P3] Add a purpose-built mobile e2e fixture to capture a live session without the browser automation pointer overlay.

final result: passed
