# Design System Specification: Editorial Organicism

## 1. Overview & Creative North Star
**The Creative North Star: "The Curated Greenhouse"**
This design system rejects the rigid, boxy constraints of traditional SaaS platforms in favor of an editorial, high-end experience. By combining an expansive white canvas with an ultra-rounded, botanical-inspired geometry, we create an interface that feels less like a "tool" and more like a high-end digital publication. 

The system moves beyond the "template" look through **Intentional Asymmetry** and **Tonal Depth**. We prioritize breathing room over information density, using the "Plus Jakarta Sans" typeface to provide a modern, geometric clarity that balances the soft, organic forms of the UI containers.

---

## 2. Colors & Surface Architecture
The palette is rooted in a clinical white base (`#FFFFFF`), punctuated by a sophisticated range of moss, lichen, and sun-drenched greens.

### Surface Hierarchy & Nesting
To achieve a premium look, we prohibit the use of 1px solid borders for sectioning. Boundaries are defined solely through background color shifts or subtle tonal transitions.

*   **Base Layer:** `surface_container_lowest` (#FFFFFF). This is your primary canvas.
*   **Secondary Layer:** `surface_container_low` (#F3F3F4). Use this for large sidebar containers or distinct content sections.
*   **Interactive/Elevated Layer:** `surface_container` (#EEEEEE). Use this for cards or nested elements sitting on a Secondary Layer.

### The "No-Line" Rule
Traditional dividers are replaced by **Negative Space** (refer to Spacing Scale `6` or `8`) or **Tonal Shifts**. If two elements sit side-by-side, the distinction should come from a shift between `surface` and `surface_container_low`, never a stroke.

### Functional Accents
*   **Primary Action:** `primary` (#476643) for high-contrast text on light buttons or solid backgrounds.
*   **Active States:** `primary_container` (#A5C89E) and `secondary_container` (#DEE9A3) act as soft highlights for navigation and selection.

---

## 3. Typography
We utilize **Plus Jakarta Sans** for its high x-height and modern geometric terminals, which lend an air of professional authority.

*   **Display (lg/md):** Reserved for hero moments. Use `display-lg` (3.5rem) with `-0.02em` letter spacing to create a high-fashion editorial feel.
*   **Headlines:** `headline-md` (1.75rem) should be used sparingly to anchor content sections.
*   **Body Copy:** `body-lg` (1rem) is the workhorse. Maintain a generous line-height (1.6) to ensure the botanical, "airy" feel is preserved.
*   **Labels:** `label-md` (0.75rem) should always be in All-Caps with `+0.05em` letter spacing when used for metadata or category tags.

---

## 4. Elevation & Depth
Depth in this system is "Atmospheric" rather than "Physical." We avoid heavy drop shadows in favor of tonal stacking and blur.

*   **The Layering Principle:** A `surface_container_highest` (#E2E2E2) card sitting on a `surface` (#F9F9F9) background creates a natural, soft lift without needing a shadow.
*   **Ambient Shadows:** For floating modals or menus, use an ultra-diffused shadow: `box-shadow: 0 20px 40px rgba(71, 102, 67, 0.06);`. Note the tinting of the shadow with a hint of the primary green to keep it organic.
*   **The Ghost Border:** If accessibility requires a container edge, use `outline_variant` (#C3C8BD) at **15% opacity**. This creates a "suggestion" of a boundary rather than a hard line.
*   **Glassmorphism:** Use `surface_container_lowest` at 80% opacity with a `backdrop-filter: blur(20px)` for sticky headers. This allows the botanical accents of the content to bleed through as the user scrolls.

---

## 5. Components

### Buttons
*   **Primary:** Solid `primary_container` (#A5C89E) with `on_primary_container` (#365433) text. Shape: `full` (pill-shaped). 
*   **Secondary:** `surface_container_high` (#E8E8E8) background. No border.
*   **Tertiary:** Text-only using `primary` (#476643) color, with an underline that only appears on hover.

### Input Fields
*   **Style:** Background `surface_container_low` (#F3F3F4), `xl` (3rem) corner radius.
*   **Focus State:** A 2px `primary` (#476643) "Ghost Border" at 20% opacity. No harsh solid outlines.

### Cards
*   **Rule:** Forbid divider lines within cards. Use Spacing Scale `4` (1.4rem) to separate header, body, and footer content.
*   **Radius:** Always `xl` (3rem) for large cards, `lg` (2rem) for smaller nested elements.

### Selection Chips
*   **Active:** `secondary_container` (#DEE9A3) background with `on_secondary_container` (#606931) text.
*   **Inactive:** `surface_container` (#EEEEEE) background.

---

## 6. Do's and Don'ts

### Do
*   **Do** use asymmetrical layouts. Place a large image off-center and balance it with `display-sm` typography.
*   **Do** utilize the `full` (9999px) radius for buttons and tags to emphasize the "Soft" nature of the system.
*   **Do** maximize white space. If you think there is enough padding, add `1rem` more.

### Don't
*   **Don't** use black (#000000) for text. Use `on_surface` (#1A1C1C) for a softer, premium contrast.
*   **Don't** use 1px dividers or borders to separate content. Let the background tones do the work.
*   **Don't** use standard "Material" shadows. If an element doesn't feel like it's floating in a soft, lit room, the shadow is too heavy.
*   **Don't** use gradients. Visual interest must be achieved through color blocking and overlapping shapes.