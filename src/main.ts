import "./style.css";

function requiredElement<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Elemento ausente: ${selector}`);
  return element;
}

const channelList = requiredElement<HTMLDivElement>("#channels");
const message = requiredElement<HTMLParagraphElement>("#message");
const refreshButton = requiredElement<HTMLButtonElement>("#refresh");
const installButton = requiredElement<HTMLButtonElement>("#install");
const repairButton = requiredElement<HTMLButtonElement>("#repair");
const uninstallButton = requiredElement<HTMLButtonElement>("#uninstall");
const licenseButton = requiredElement<HTMLButtonElement>("#license");
const closeLicenseButton = requiredElement<HTMLButtonElement>("#close-license");
const licenseDialog = requiredElement<HTMLDialogElement>("#license-dialog");
const licenseText = requiredElement<HTMLPreElement>("#license-text");

let busy = false;
let supported = false;
let runtimeReady = false;
const stateLabels: Record<ChannelState, string> = {
  vanilla: "ORIGINAL",
  installed: "PROTEGIDO",
  foreign: "PRESERVADO",
  broken: "REPARO",
};

function updateButtons(): void {
  refreshButton.disabled = busy;
  installButton.disabled = busy || !supported || !runtimeReady;
  repairButton.disabled = busy || !supported || !runtimeReady;
  uninstallButton.disabled = busy || !supported;
  document.body.classList.toggle("busy", busy);
}

function setBusy(value: boolean): void {
  busy = value;
  updateButtons();
}

function renderChannel(channel: ChannelStatus): HTMLElement {
  const article = document.createElement("article");
  article.className = `channel state-${channel.state}`;

  const identity = document.createElement("div");
  const name = document.createElement("strong");
  name.textContent = channel.flavour;
  const version = document.createElement("small");
  version.textContent = `app-${channel.version}`;
  identity.append(name, version);

  const detail = document.createElement("p");
  detail.textContent = channel.detail;

  const badge = document.createElement("span");
  badge.className = "badge";
  badge.textContent = stateLabels[channel.state];

  article.append(identity, detail, badge);
  return article;
}

function render(overview: Overview): void {
  supported = overview.supported;
  runtimeReady = overview.runtimeReady;
  channelList.replaceChildren();
  if (!overview.supported) {
    const unsupported = document.createElement("p");
    unsupported.className = "empty";
    unsupported.textContent = "Esta versao suporta somente Windows.";
    channelList.append(unsupported);
  } else if (overview.channels.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Discord Stable, PTB ou Canary nao foi encontrado.";
    channelList.append(empty);
  } else {
    channelList.append(...overview.channels.map(renderChannel));
  }

  message.textContent = overview.message || (overview.runtimeReady ? "Runtime Tor verificado e pronto." : "Build sem o runtime Tor.");
  message.classList.toggle("error", !overview.runtimeReady);
  updateButtons();
}

async function run(action: () => Promise<Overview>): Promise<void> {
  setBusy(true);
  message.classList.remove("error");
  message.textContent = "Verificando arquivos e fechando somente o Discord selecionado...";
  try {
    render(await action());
  } catch (error) {
    message.textContent = error instanceof Error ? error.message : String(error);
    message.classList.add("error");
  } finally {
    setBusy(false);
  }
}

refreshButton.addEventListener("click", () => void run(() => window.golive.status()));
installButton.addEventListener("click", () => void run(() => window.golive.install()));
repairButton.addEventListener("click", () => void run(() => window.golive.repair()));
uninstallButton.addEventListener("click", () => void run(() => window.golive.uninstall()));
licenseButton.addEventListener("click", async () => {
  licenseText.textContent ||= await window.golive.license();
  licenseDialog.showModal();
});
closeLicenseButton.addEventListener("click", () => licenseDialog.close());

void run(() => window.golive.status());
