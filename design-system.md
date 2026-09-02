# Machora design system

## Direction

Minimal dark operations console for developers, following the simplified Operations Deck direction.

## Tokens

- Canvas: `#0b0f12`
- Surface: `#10161a`
- Elevated surface: `#141b1f`
- Border: `#293238`
- Text: `#f2f5f2`
- Muted text: `#8e999e`
- Accent / online: `#9ceb32`
- Warning: `#f3ad32`
- Danger: `#f06a6a`
- Typography: Inter with system sans fallbacks; monospace for addresses and commands.
- Shape: 6–10px radii, 1px borders, no gradients, no decorative shadows.
- Motion: 160ms state transitions; respect reduced motion.

## Interaction rules

- One primary action per screen: Add machine.
- Visible keyboard focus on every control.
- Host rows remain readable at 1024px; below 760px they become stacked rows.
- Enrollment is a dismissible side panel on desktop and a full-screen sheet on small screens.
