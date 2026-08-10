import { ensureChromeEnv } from "../lib/chrome-env";

ensureChromeEnv();

import { getSettings, onSettingsChanged, removeFromIgnoreList, setDomainOverride, setSettings } from "../lib/storage";
import type { FilterSettings, Mode } from "../lib/types";

const globalModeButtons = document.querySelectorAll<HTMLButtonElement>('[data-role="global-mode"] button');

const brightnessInput = document.querySelector<HTMLInputElement>('[data-role="brightness"]')!;
const contrastInput = document.querySelector<HTMLInputElement>('[data-role="contrast"]')!;
const sepiaInput = document.querySelector<HTMLInputElement>('[data-role="sepia"]')!;
const brightnessValue = document.querySelector<HTMLElement>('[data-role="brightness-value"]')!;
const contrastValue = document.querySelector<HTMLElement>('[data-role="contrast-value"]')!;
const sepiaValue = document.querySelector<HTMLElement>('[data-role="sepia-value"]')!;

const overridesList = document.querySelector<HTMLUListElement>('[data-role="overrides-list"]')!;
const overridesEmpty = document.querySelector<HTMLElement>('[data-role="overrides-empty"]')!;
const ignoreList = document.querySelector<HTMLUListElement>('[data-role="ignore-list"]')!;
const ignoreEmpty = document.querySelector<HTMLElement>('[data-role="ignore-empty"]')!;

function renderGlobalMode(mode: Mode): void {
  globalModeButtons.forEach((btn) => {
    btn.setAttribute("aria-pressed", String(btn.dataset.value === mode));
  });
}

function renderSliders(filterSettings: FilterSettings): void {
  brightnessInput.value = String(filterSettings.brightness);
  contrastInput.value = String(filterSettings.contrast);
  sepiaInput.value = String(filterSettings.sepia);
  brightnessValue.textContent = `${filterSettings.brightness}%`;
  contrastValue.textContent = `${filterSettings.contrast}%`;
  sepiaValue.textContent = `${filterSettings.sepia}%`;
}

function renderList(
  container: HTMLUListElement,
  emptyEl: HTMLElement,
  items: Array<{ key: string; label: string }>,
  onRemove: (key: string) => void,
): void {
  container.innerHTML = "";
  emptyEl.hidden = items.length > 0;

  for (const { key, label } of items) {
    const li = document.createElement("li");
    li.className = "list-item";

    const span = document.createElement("span");
    span.textContent = label;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "remove";
    button.textContent = "Remove";
    button.addEventListener("click", () => onRemove(key));

    li.append(span, button);
    container.append(li);
  }
}

async function refresh(): Promise<void> {
  const settings = await getSettings();
  renderGlobalMode(settings.globalMode);
  renderSliders(settings.filterSettings);

  renderList(
    overridesList,
    overridesEmpty,
    Object.entries(settings.domainOverrides).map(([domain, mode]) => ({ key: domain, label: `${domain} — ${mode}` })),
    (domain) => void setDomainOverride(domain, null),
  );

  renderList(
    ignoreList,
    ignoreEmpty,
    settings.ignoreList.map((domain) => ({ key: domain, label: domain })),
    (domain) => void removeFromIgnoreList(domain),
  );
}

globalModeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    void setSettings({ globalMode: btn.dataset.value as Mode });
  });
});

function wireSlider(input: HTMLInputElement, output: HTMLElement, key: keyof FilterSettings): void {
  input.addEventListener("input", () => {
    output.textContent = `${input.value}%`;
  });
  input.addEventListener("change", () => {
    void getSettings().then((settings) =>
      setSettings({ filterSettings: { ...settings.filterSettings, [key]: Number(input.value) } }),
    );
  });
}

wireSlider(brightnessInput, brightnessValue, "brightness");
wireSlider(contrastInput, contrastValue, "contrast");
wireSlider(sepiaInput, sepiaValue, "sepia");

onSettingsChanged(() => void refresh());

void refresh();
