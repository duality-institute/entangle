/*
 * `?fixture=NAME` renders the default export from `fixtures/NAME.tsx` in dev.
 * StrictMode stays off because its remount cycle corrupts stream measurements.
 */

import { createRoot } from "react-dom/client";
import type { ComponentType } from "react";

type FixtureModule = { default: ComponentType };

const FIXTURES = import.meta.glob<FixtureModule>("./fixtures/*.tsx");

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

function fixtureNames(): string[] {
  return Object.keys(FIXTURES)
    .map((path) => path.replace("./fixtures/", "").replace(/\.tsx$/, ""))
    .sort();
}

function Missing({ name }: { name: string }) {
  return (
    <div className="app-shell" data-testid="fixture-missing">
      <main className="transcript">
        <div className="transcript__empty">
          <h1 className="transcript__empty-title">No fixture “{name}”</h1>
          <p className="transcript__empty-body">
            Available: {fixtureNames().join(", ") || "none"}
          </p>
        </div>
      </main>
    </div>
  );
}

export async function mountFixture(container: HTMLElement, name: string): Promise<void> {
  const root = createRoot(container);
  const loader = NAME_PATTERN.test(name) ? FIXTURES[`./fixtures/${name}.tsx`] : undefined;

  if (!loader) {
    root.render(<Missing name={name} />);
    return;
  }

  const module = await loader();
  const Fixture = module.default;
  root.render(<Fixture />);
}
