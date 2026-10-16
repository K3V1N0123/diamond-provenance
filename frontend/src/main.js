import {
  BrowserProvider,
  Contract,
  JsonRpcProvider,
  TypedDataEncoder,
  getAddress,
  id,
  isAddress,
  keccak256,
} from "ethers";
import "./styles.css";

const ORIGINS = ["Natural", "Lab-grown CVD", "Lab-grown HPHT"];
const STATUSES = ["Active", "Quarantined", "Revoked"];
const LAB_ROLE = id("LAB_ROLE");
const CUSTODIAN_ROLE = id("CUSTODIAN_ROLE");
const DETAILS_TYPES = {
  Details: [
    { name: "color", type: "string" },
    { name: "clarity", type: "string" },
    { name: "cut", type: "string" },
    { name: "treatment", type: "string" },
  ],
};

const elements = Object.fromEntries([
  "network-status", "network-label", "verify-form", "verify-button", "lab-address",
  "inscription-id", "form-message", "result", "result-inscription", "record-status",
  "record-origin", "record-carat", "record-date", "record-id", "certificate-details",
  "metadata-check", "record-lab", "record-custodian", "record-report", "freshness",
  "timeline", "configuration-error", "configuration-message", "connect-wallet",
  "wallet-summary", "direct-registration-form", "registration-fields", "report-file",
  "report-hash", "registration-inscription", "registration-origin", "registration-carat",
  "registration-color", "registration-clarity", "registration-cut",
  "registration-treatment", "registration-message", "register-button",
].map((id) => [id, document.getElementById(id)]));

let config;
let provider;
let registry;
let walletRegistry;
let walletAddress;

function shortenAddress(address) {
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function normalizeInscription(value) {
  return value.trim().toUpperCase();
}

function setMessage(message, tone = "") {
  elements["form-message"].textContent = message;
  elements["form-message"].dataset.tone = tone;
}

function setRegistrationMessage(message, tone = "") {
  elements["registration-message"].textContent = message;
  elements["registration-message"].dataset.tone = tone;
}

function readableError(error) {
  return error.shortMessage ?? error.reason ?? error.info?.error?.message ?? error.message;
}

async function hashReport(file) {
  return keccak256(new Uint8Array(await file.arrayBuffer()));
}

async function connectWallet() {
  if (!window.ethereum) {
    throw new Error("MetaMask or another injected Ethereum wallet was not found.");
  }

  const walletProvider = new BrowserProvider(window.ethereum);
  await walletProvider.send("eth_requestAccounts", []);
  const walletNetwork = await walletProvider.getNetwork();
  if (walletNetwork.chainId.toString() !== config.chainId.toString()) {
    throw new Error(
      `Your wallet is on chain ${walletNetwork.chainId}. Switch it to chain ${config.chainId}.`,
    );
  }

  const signer = await walletProvider.getSigner();
  walletAddress = await signer.getAddress();
  walletRegistry = new Contract(config.contractAddress, config.abi, signer);
  const [isLab, isCustodian] = await Promise.all([
    walletRegistry.hasRole(LAB_ROLE, walletAddress),
    walletRegistry.hasRole(CUSTODIAN_ROLE, walletAddress),
  ]);

  elements["connect-wallet"].textContent = shortenAddress(walletAddress);
  elements["wallet-summary"].textContent = isLab && isCustodian
    ? `${shortenAddress(walletAddress)} is authorized as a lab and custodian.`
    : `${shortenAddress(walletAddress)} needs both LAB_ROLE and CUSTODIAN_ROLE.`;
  elements["registration-fields"].disabled = !(isLab && isCustodian);
  setRegistrationMessage(
    isLab && isCustodian
      ? "Wallet ready. The registration transaction will require gas."
      : "This wallet is not authorized to register diamonds.",
    isLab && isCustodian ? "success" : "error",
  );
}

function addDefinition(list, term, value) {
  const row = document.createElement("div");
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = term;
  dd.textContent = value || "Not stated";
  row.append(dt, dd);
  list.append(row);
}

function eventDescription(event) {
  switch (event.fragment.name) {
    case "DiamondRegistered":
      return {
        title: "Registered by laboratory",
        detail: `${event.args.inscriptionId} entered the registry`,
      };
    case "RegistrationRelayed":
      return {
        title: "Registration relayed",
        detail: `Submitted by ${shortenAddress(event.args.relayer)}`,
      };
    case "TransferAccepted":
      return {
        title: "Custody transferred",
        detail: `${shortenAddress(event.args.from)} → ${shortenAddress(event.args.to)}`,
      };
    case "StatusChanged":
      return {
        title: `Status changed to ${STATUSES[Number(event.args.status)]}`,
        detail: `${event.args.reason} · by ${shortenAddress(event.args.by)}`,
      };
    default:
      return { title: event.fragment.name, detail: "" };
  }
}

async function renderTimeline(events) {
  elements.timeline.replaceChildren();
  const blockNumbers = [...new Set(events.map((event) => event.blockNumber))];
  const blocks = new Map(await Promise.all(blockNumbers.map(async (blockNumber) => {
    const block = await provider.getBlock(blockNumber);
    return [blockNumber, block];
  })));

  for (const event of events) {
    const item = document.createElement("li");
    const marker = document.createElement("span");
    marker.className = "timeline-marker";
    const content = document.createElement("div");
    const title = document.createElement("strong");
    const detail = document.createElement("p");
    const meta = document.createElement("time");
    const description = eventDescription(event);
    const block = blocks.get(event.blockNumber);

    title.textContent = description.title;
    detail.textContent = description.detail;
    meta.textContent = `${new Date(Number(block.timestamp) * 1000).toLocaleString()} · block ${event.blockNumber}`;
    content.append(title, detail, meta);
    item.append(marker, content);
    elements.timeline.append(item);
  }
}

async function verifyDiamond(lab, inscription) {
  const latestBlock = await provider.getBlockNumber();
  const id = await registry.findByInscription(lab, inscription);
  if (id === 0n) throw new Error("No record was found for this laboratory and inscription.");

  const diamond = await registry.getDiamond(id);
  const filters = [
    registry.filters.DiamondRegistered(id),
    registry.filters.DiamondDetails(id),
    registry.filters.RegistrationRelayed(id),
    registry.filters.TransferAccepted(id),
    registry.filters.StatusChanged(id),
  ];
  const eventGroups = await Promise.all(filters.map((filter) =>
    registry.queryFilter(filter, config.deploymentBlock, latestBlock)));
  const events = eventGroups.flat().sort((left, right) =>
    left.blockNumber - right.blockNumber || left.index - right.index);
  const registeredEvent = events.find((event) => event.fragment.name === "DiamondRegistered");
  const detailsEvent = events.find((event) => event.fragment.name === "DiamondDetails");

  elements["result-inscription"].textContent = registeredEvent?.args.inscriptionId ?? inscription;
  elements["record-status"].textContent = STATUSES[Number(diamond.status)];
  elements["record-status"].dataset.status = STATUSES[Number(diamond.status)].toLowerCase();
  elements["record-origin"].textContent = ORIGINS[Number(diamond.origin)];
  elements["record-carat"].textContent = `${(Number(diamond.caratMilli) / 1000).toFixed(3)} ct`;
  elements["record-date"].textContent = new Date(Number(diamond.registeredAt) * 1000).toLocaleDateString();
  elements["record-id"].textContent = `#${id}`;
  elements["record-lab"].textContent = diamond.lab;
  elements["record-custodian"].textContent = diamond.custodian;
  elements["record-report"].textContent = diamond.reportHash;
  elements.freshness.textContent = `Read through block ${latestBlock}`;

  elements["certificate-details"].replaceChildren();
  if (detailsEvent) {
    const details = {
      color: detailsEvent.args.color,
      clarity: detailsEvent.args.clarity,
      cut: detailsEvent.args.cut,
      treatment: detailsEvent.args.treatment,
    };
    addDefinition(elements["certificate-details"], "Color", details.color);
    addDefinition(elements["certificate-details"], "Clarity", details.clarity);
    addDefinition(elements["certificate-details"], "Cut", details.cut);
    addDefinition(elements["certificate-details"], "Treatment", details.treatment);
    const computedHash = TypedDataEncoder.hashStruct("Details", DETAILS_TYPES, details);
    const matches = computedHash === diamond.metadataHash;
    elements["metadata-check"].textContent = matches
      ? "✓ Details match the on-chain commitment"
      : "⚠ Details do not match the on-chain commitment";
    elements["metadata-check"].dataset.matches = String(matches);
  } else {
    elements["metadata-check"].textContent = "Certificate detail event was not found.";
    elements["metadata-check"].dataset.matches = "false";
  }

  await renderTimeline(events.filter((event) => event.fragment.name !== "DiamondDetails"));
  elements.result.hidden = false;
  elements.result.scrollIntoView({ behavior: "smooth", block: "start" });
}

async function initialize() {
  try {
    const response = await fetch("/registry.json", { cache: "no-store" });
    if (!response.ok) throw new Error("Run the frontend preparation command first.");
    config = await response.json();
    provider = new JsonRpcProvider(config.rpcUrl, Number(config.chainId));
    const connectedNetwork = await provider.getNetwork();
    if (connectedNetwork.chainId.toString() !== config.chainId.toString()) {
      throw new Error(`RPC returned chain ${connectedNetwork.chainId}; expected ${config.chainId}.`);
    }
    registry = new Contract(config.contractAddress, config.abi, provider);
    const latestBlock = await provider.getBlockNumber();
    elements["network-label"].textContent = `${config.network} · block ${latestBlock}`;
    elements["network-status"].dataset.connected = "true";
    elements["connect-wallet"].disabled = false;

    const parameters = new URLSearchParams(window.location.search);
    if (parameters.has("lab")) elements["lab-address"].value = parameters.get("lab");
    if (parameters.has("inscription")) {
      elements["inscription-id"].value = normalizeInscription(parameters.get("inscription"));
    }
  } catch (error) {
    elements["network-label"].textContent = "Registry unavailable";
    elements["configuration-error"].hidden = false;
    elements["configuration-message"].textContent = error.message;
    elements["verify-button"].disabled = true;
    elements["connect-wallet"].disabled = true;
  }
}

elements["connect-wallet"].addEventListener("click", async () => {
  elements["connect-wallet"].disabled = true;
  setRegistrationMessage("Waiting for wallet connection…");
  try {
    await connectWallet();
  } catch (error) {
    setRegistrationMessage(readableError(error), "error");
  } finally {
    elements["connect-wallet"].disabled = false;
  }
});

elements["report-file"].addEventListener("change", async (event) => {
  const [file] = event.target.files;
  if (!file) {
    elements["report-hash"].textContent = "The file is hashed locally and is not uploaded.";
    return;
  }

  try {
    elements["report-hash"].textContent = "Calculating report fingerprint…";
    const reportHash = await hashReport(file);
    elements["report-hash"].textContent = `Report hash: ${reportHash}`;
  } catch (error) {
    elements["report-hash"].textContent = readableError(error);
  }
});

elements["registration-inscription"].addEventListener("blur", (event) => {
  event.target.value = normalizeInscription(event.target.value);
});

elements["direct-registration-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!walletRegistry || !walletAddress) {
    setRegistrationMessage("Connect an authorized laboratory wallet first.", "error");
    return;
  }

  const inscriptionId = normalizeInscription(elements["registration-inscription"].value);
  const caratText = elements["registration-carat"].value.trim();
  const [reportFile] = elements["report-file"].files;
  elements["registration-inscription"].value = inscriptionId;

  if (!/^[A-Z0-9-]{1,64}$/.test(inscriptionId)) {
    setRegistrationMessage("The inscription may contain only A–Z, 0–9, and hyphens.", "error");
    return;
  }
  if (!/^\d+(\.\d{1,3})?$/.test(caratText)) {
    setRegistrationMessage("Carat weight must use at most three decimal places.", "error");
    return;
  }
  const caratMilli = Math.round(Number(caratText) * 1000);
  if (caratMilli < 1 || caratMilli > 1_000_000) {
    setRegistrationMessage("Carat weight must be between 0.001 and 1000.", "error");
    return;
  }
  if (!reportFile) {
    setRegistrationMessage("Choose the grading report file.", "error");
    return;
  }

  elements["register-button"].disabled = true;
  try {
    setRegistrationMessage("Hashing the report locally…");
    const reportHash = await hashReport(reportFile);
    const claim = {
      inscriptionId,
      reportHash,
      origin: Number(elements["registration-origin"].value),
      caratMilli,
      color: elements["registration-color"].value.trim(),
      clarity: elements["registration-clarity"].value.trim(),
      cut: elements["registration-cut"].value.trim(),
      treatment: elements["registration-treatment"].value.trim(),
    };

    setRegistrationMessage("Confirm the registration transaction in your wallet…");
    const transaction = await walletRegistry.registerDiamond(claim);
    setRegistrationMessage(`Transaction ${shortenAddress(transaction.hash)} submitted. Waiting for confirmation…`);
    await transaction.wait();

    elements["lab-address"].value = walletAddress;
    elements["inscription-id"].value = inscriptionId;
    await verifyDiamond(walletAddress, inscriptionId);
    setRegistrationMessage("Diamond registered and verified from the blockchain.", "success");
  } catch (error) {
    setRegistrationMessage(readableError(error), "error");
  } finally {
    elements["register-button"].disabled = false;
  }
});

elements["inscription-id"].addEventListener("blur", (event) => {
  event.target.value = normalizeInscription(event.target.value);
});

elements["verify-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const labInput = elements["lab-address"].value.trim();
  const inscription = normalizeInscription(elements["inscription-id"].value);
  elements["inscription-id"].value = inscription;
  elements.result.hidden = true;

  if (!isAddress(labInput)) {
    setMessage("Enter a valid Ethereum laboratory address.", "error");
    return;
  }
  if (!/^[A-Z0-9-]{1,64}$/.test(inscription)) {
    setMessage("The inscription may contain only A–Z, 0–9, and hyphens.", "error");
    return;
  }

  elements["verify-button"].disabled = true;
  setMessage("Reading the registry and reconstructing its history…");
  try {
    const lab = getAddress(labInput);
    await verifyDiamond(lab, inscription);
    const url = new URL(window.location.href);
    url.searchParams.set("lab", lab);
    url.searchParams.set("inscription", inscription);
    window.history.replaceState({}, "", url);
    setMessage("Record verified from the blockchain.", "success");
  } catch (error) {
    setMessage(readableError(error), "error");
  } finally {
    elements["verify-button"].disabled = false;
  }
});

if (window.ethereum?.on) {
  window.ethereum.on("accountsChanged", () => window.location.reload());
  window.ethereum.on("chainChanged", () => window.location.reload());
}

initialize();
