/*
 * entangle — model picker
 * ------------------------------------------------------------------
 * Providers remain grouped and the choice applies to the NEXT prompt only.
 */

import { useCallback, useMemo, useState } from "react";

import type { ModelRef } from "../lib/appState";
import type { ProviderDto } from "../lib/protocol";
import PickerModal, { Caret, CheckMark } from "./PickerModal";
import "../styles/controls.css";

interface ModelPickerProps {
  providers: ProviderDto[];
  /** `nextModel` from the store. */
  value?: ModelRef;
  onChange: (model: ModelRef) => void;
  disabled?: boolean;
}

type ModelRow = { id: string; name: string; deprecated: boolean };
type ProviderGroup = { id: string; name: string; models: ModelRow[] };

function selectValue(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`;
}

function toGroups(providers: ProviderDto[]): ProviderGroup[] {
  return providers.map((provider) => ({
    id: provider.id,
    name: provider.name || provider.id,
    models: Object.values(provider.models ?? {})
      .map((model) => ({
        id: model.id,
        name: model.name || model.id,
        deprecated: model.status === "deprecated",
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export default function ModelPicker({
  providers,
  value,
  onChange,
  disabled = false,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const groups = useMemo(() => toGroups(providers), [providers]);
  const hasModels = groups.some((group) => group.models.length > 0);
  const valueKey = value ? selectValue(value.providerID, value.modelID) : "";
  const close = useCallback(() => setOpen(false), []);

  const label = useMemo(() => {
    if (!value) return "model";
    const group = groups.find((g) => g.id === value.providerID);
    const model = group?.models.find((m) => m.id === value.modelID);
    return model?.name ?? value.modelID;
  }, [groups, value]);

  const choose = useCallback(
    (providerID: string, modelID: string) => {
      onChange({ providerID, modelID });
      setOpen(false);
    },
    [onChange],
  );

  return (
    <>
      <button
        type="button"
        className="chip chip--model"
        data-testid="model-chip"
        data-model={valueKey}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Model for next message: ${label}`}
        disabled={disabled || !hasModels}
        onClick={() => setOpen(true)}
      >
        <span className="chip__label">{label}</span>
        <span className="chip__caret" aria-hidden="true"><Caret /></span>
      </button>

      <PickerModal
        open={open}
        testId="model-modal"
        title="Choose model"
        onClose={close}
      >
        <div className="sheet__body" role="radiogroup" aria-label="Models">
          {groups.map((group) => (
            <section className="sheet-section" key={group.id} data-provider={group.id}>
              <h3 className="sheet-section__title">{group.name}</h3>
              {group.models.map((model) => {
                const checked = value?.providerID === group.id && value?.modelID === model.id;
                return (
                  <button
                    key={model.id}
                    type="button"
                    className="sheet-option"
                    data-testid="model-option"
                    data-model={selectValue(group.id, model.id)}
                    role="radio"
                    aria-checked={checked}
                    onClick={() => choose(group.id, model.id)}
                  >
                    <span className="sheet-option__text">
                      <span className="sheet-option__name">{model.name}</span>
                      <span className="sheet-option__desc sheet-option__id">{model.id}</span>
                    </span>
                    {model.deprecated ? <span className="sheet-option__meta">deprecated</span> : null}
                    <span className="sheet-option__mark" aria-hidden="true">
                      {checked ? <CheckMark /> : null}
                    </span>
                  </button>
                );
              })}
            </section>
          ))}
        </div>
      </PickerModal>
    </>
  );
}
