import { expect } from "chai";
import { network } from "hardhat";

const { ethers } = await network.connect();

const LAB_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LAB_ROLE"));
const CUSTODIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CUSTODIAN_ROLE"));
const REPORT_HASH = ethers.keccak256(ethers.toUtf8Bytes("report-1"));

const input = (inscriptionId = "GIA-2467891", reportHash = REPORT_HASH) => ({
  inscriptionId,
  reportHash,
  origin: 1,
  caratMilli: 1250,
  color: "F",
  clarity: "VS1",
  cut: "Excellent",
  treatment: "None",
});

async function deployRegistry() {
  const [admin, lab, manufacturer, relayer] = await ethers.getSigners();
  const registry = await ethers.deployContract("DiamondRegistry");
  await registry.waitForDeployment();
  await registry.grantRole(LAB_ROLE, lab.address);
  await registry.grantRole(CUSTODIAN_ROLE, lab.address);
  await registry.grantRole(CUSTODIAN_ROLE, manufacturer.address);
  return { registry, admin, lab, manufacturer, relayer };
}

describe("DiamondRegistry", function () {
  it("registers a valid diamond and rejects unauthorized registration", async function () {
    const { registry, lab, relayer } = await deployRegistry();

    await expect(registry.connect(lab).registerDiamond(input()))
      .to.emit(registry, "DiamondRegistered")
      .withArgs(1n, lab.address, "GIA-2467891", 1, 1250);

    const diamond = await registry.getDiamond(1);
    expect(diamond.lab).to.equal(lab.address);
    expect(diamond.custodian).to.equal(lab.address);
    expect(diamond.reportHash).to.equal(REPORT_HASH);

    await expect(registry.connect(relayer).registerDiamond(input("GIA-2467892")))
      .to.be.revertedWith("Not a lab");
  });

  it("rejects duplicate inscriptions and report hashes for the same lab", async function () {
    const { registry, lab } = await deployRegistry();
    await registry.connect(lab).registerDiamond(input());

    await expect(registry.connect(lab).registerDiamond(input()))
      .to.be.revertedWith("Duplicate inscription");
    await expect(registry.connect(lab).registerDiamond(input("GIA-2467892")))
      .to.be.revertedWith("Duplicate report");
  });

  it("requires recipient consent for custody transfer", async function () {
    const { registry, lab, manufacturer } = await deployRegistry();
    await registry.connect(lab).registerDiamond(input());

    await expect(registry.connect(lab).proposeTransfer(1, manufacturer.address))
      .to.emit(registry, "TransferProposed")
      .withArgs(1n, lab.address, manufacturer.address);
    expect(await registry.pendingTo(1)).to.equal(manufacturer.address);

    await expect(registry.connect(manufacturer).acceptTransfer(1))
      .to.emit(registry, "TransferAccepted")
      .withArgs(1n, lab.address, manufacturer.address);
    expect((await registry.getDiamond(1)).custodian).to.equal(manufacturer.address);
  });

  it("clears pending transfers during quarantine and supports admin resolution or revocation", async function () {
    const { registry, admin, lab, manufacturer } = await deployRegistry();
    await registry.connect(lab).registerDiamond(input());
    await registry.connect(lab).proposeTransfer(1, manufacturer.address);

    await expect(registry.connect(lab).quarantine(1, "Report under review"))
      .to.emit(registry, "StatusChanged")
      .withArgs(1n, 1, lab.address, "Report under review");
    expect(await registry.pendingTo(1)).to.equal(ethers.ZeroAddress);
    await expect(registry.connect(manufacturer).acceptTransfer(1))
      .to.be.revertedWith("Record not active");

    await registry.connect(admin).resolveQuarantine(1, "Review cleared");
    expect((await registry.getDiamond(1)).status).to.equal(0);
    await registry.connect(lab).quarantine(1, "Fraud confirmed");
    await registry.connect(admin).revokeRecord(1, "Record revoked");
    expect((await registry.getDiamond(1)).status).to.equal(2);
  });

  it("accepts a valid EIP-712 registration from a relayer and blocks replay", async function () {
    const { registry, lab, relayer } = await deployRegistry();
    const network = await ethers.provider.getNetwork();
    const claim = input("GIA-2467899", ethers.keccak256(ethers.toUtf8Bytes("report-9")));
    const nonce = 42n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const domain = {
      name: "DiamondProvenance",
      version: "1",
      chainId: network.chainId,
      verifyingContract: await registry.getAddress(),
    };
    const types = {
      Registration: [
        { name: "lab", type: "address" },
        { name: "claim", type: "DiamondClaim" },
        { name: "nonce", type: "uint256" },
        { name: "deadline", type: "uint64" },
      ],
      DiamondClaim: [
        { name: "inscriptionId", type: "string" },
        { name: "reportHash", type: "bytes32" },
        { name: "origin", type: "uint8" },
        { name: "caratMilli", type: "uint32" },
        { name: "details", type: "Details" },
      ],
      Details: [
        { name: "color", type: "string" },
        { name: "clarity", type: "string" },
        { name: "cut", type: "string" },
        { name: "treatment", type: "string" },
      ],
    };
    const value = {
      lab: lab.address,
      claim: {
        inscriptionId: claim.inscriptionId,
        reportHash: claim.reportHash,
        origin: claim.origin,
        caratMilli: claim.caratMilli,
        details: {
          color: claim.color,
          clarity: claim.clarity,
          cut: claim.cut,
          treatment: claim.treatment,
        },
      },
      nonce,
      deadline,
    };
    const signature = await lab.signTypedData(domain, types, value);
    expect(await registry.registrationDigest(
      lab.address, claim, nonce, deadline,
    )).to.equal(ethers.TypedDataEncoder.hash(domain, types, value));

    await expect(registry.connect(relayer).registerWithSignature(
      lab.address, claim, nonce, deadline, signature,
    )).to.emit(registry, "RegistrationRelayed").withArgs(1n, lab.address, relayer.address);
    expect((await registry.getDiamond(1)).custodian).to.equal(lab.address);

    await expect(registry.connect(relayer).registerWithSignature(
      lab.address, claim, nonce, deadline, signature,
    )).to.be.revertedWith("Nonce used");
  });
});
