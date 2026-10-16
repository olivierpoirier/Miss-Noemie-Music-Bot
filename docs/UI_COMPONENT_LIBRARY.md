# UI Component Library

This project now has a small reusable UI base under:

```text
frontend/src/components/ui/
```

Use it as a personal starter kit for other apps when you want consistent buttons,
inputs, labels, theme behavior, icons, disabled states, and loading states.

## Copy Into Another React App

Copy these files:

```text
frontend/src/components/ui/Button.tsx
frontend/src/components/ui/TextInput.tsx
frontend/src/components/ui/FieldLabel.tsx
frontend/src/components/ui/index.ts
frontend/src/lib/cn.ts
```

Install the icon dependency if the other app does not already have it:

```bash
npm install lucide-react
```

If the other app does not have this project's themes, either copy
`frontend/src/lib/themes.ts` too, or simplify the `theme` prop in
`TextInput` and `FieldLabel` to a local string union such as:

```ts
type ThemeName = "default" | "adventurer" | "premium";
```

Then copy the CSS classes used by the components:

```text
.theme-active-button
.themed-secondary-button
.themed-danger-button
.themed-border
.rainbow-border
.rainbow-cycle
.organic-panel
```

The fastest path is to copy the relevant blocks from:

```text
frontend/src/styles/components.css
frontend/src/styles/effects.css
```

## Nice Input Pattern

This is the input style shown in the app:

```tsx
import { Link2 } from "lucide-react";
import { FieldLabel, TextInput } from "./components/ui";

<div className="flex flex-col">
  <FieldLabel theme={theme} rainbow={rainbow} icon={Link2} htmlFor="source">
    Source Signal
  </FieldLabel>

  <TextInput
    id="source"
    theme={theme}
    rainbow={rainbow}
    placeholder="Spotify, YouTube, SoundCloud ou recherche"
    value={source}
    onChange={(event) => setSource(event.target.value)}
    autoComplete="url"
    scanlines
  />
</div>
```

For future reuse across many apps, move these files into a separate repo like:

```text
noemie-ui/
  src/components/Button.tsx
  src/components/TextInput.tsx
  src/components/FieldLabel.tsx
  src/styles.css
```

Then each app can import the same source instead of copying it again.

## Input Shape Rule

Keep text inputs as dark capsules with a real theme-gradient border:

- border radius: `--ui-control-radius`
- border width: `--ui-border-width`
- border colors: `--c1` to `--c2`
- implementation: layered `background` using `padding-box` and `border-box`

Avoid pseudo-element borders for inputs; they are easier to clip and can make
corners look broken.

## Button

```tsx
import { Plus, Trash2 } from "lucide-react";
import { Button } from "./components/ui";

<Button icon={Plus} variant="primary" size="lg">
  Ajouter
</Button>

<Button icon={Trash2} variant="danger" size="sm">
  Supprimer
</Button>

<Button loading variant="primary">
  Chargement
</Button>
```

Supported variants:

- `primary`
- `secondary`
- `danger`
- `ghost`
- `toggle`

Supported sizes:

- `xs`
- `sm`
- `md`
- `lg`
- `icon`

## TextInput

```tsx
import { Link2 } from "lucide-react";
import { TextInput } from "./components/ui";

<TextInput
  theme={theme}
  rainbow={rainbow}
  icon={Link2}
  placeholder="Colle un lien"
  value={value}
  onChange={(event) => setValue(event.target.value)}
/>
```

## FieldLabel

```tsx
import { User } from "lucide-react";
import { FieldLabel } from "./components/ui";

<FieldLabel theme={theme} rainbow={rainbow} icon={User} htmlFor="operator">
  Operator ID
</FieldLabel>
```

## Good Next Step

For a visual database of buttons/inputs across multiple apps, use Storybook.
The component library stays in code, and Storybook becomes the clickable catalog:
variants, sizes, states, examples, and design notes.
