import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.getOrCreate();

const LAB_ROLE = ethers.keccak256(ethers.toUtf8Bytes("LAB_ROLE"));
const CUSTODIAN_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CUSTODIAN_ROLE"));
const REPORT_HASH = ethers.keccak256(ethers.toUtf8Bytes("report-1"));

const TYPES = {
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

const input = (overrides = {}) => ({
  inscriptionId: "GIA-2467891",
  reportHash: REPORT_HASH,
  origin: 1,
  caratMilli: 1250,
  color: "F",
  clarity: "VS1",
  cut: "Excellent",
  treatment: "None",
  ...overrides,
});

async function deployRegistry() {
  const [admin, lab, manufacturer, retailer, relayer, outsider, secondLab] =
    await ethers.getSigners();
  const registry = await ethers.deployContract("DiamondRegistry");
  await registry.waitForDeployment();
  await registry.grantRole(LAB_ROLE, lab.address);
  await registry.grantRole(CUSTODIAN_ROLE, lab.address);
  await registry.grantRole(CUSTODIAN_ROLE, manufacturer.address);
  await registry.grantRole(CUSTODIAN_ROLE, retailer.address);
  return { registry, admin, lab, manufacturer, retailer, relayer, outsider, secondLab };
}

function registrationValue(lab, claim, nonce, deadline) {
  return {
    lab,
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
}

async function signRegistration(registry, signer, claim, options = {}) {
  const currentNetwork = await ethers.provider.getNetwork();
  const latestBlock = await ethers.provider.getBlock("latest");
  const nonce = options.nonce ?? 42n;
  const deadline = options.deadline ?? BigInt(latestBlock.timestamp + 3600);
  const domain = {
    name: "DiamondProvenance",
    version: "1",
    chainId: options.chainId ?? currentNetwork.chainId,
    verifyingContract: options.verifyingContract ?? await registry.getAddress(),
  };
  const value = registrationValue(signer.address, claim, nonce, deadline);
  const signature = await signer.signTypedData(domain, TYPES, value);
  return { domain, value, nonce, deadline, signature };
}

describe("DiamondRegistry", function () {
  describe("direct registration", function () {
    it("registers a valid diamond with the lab as first custodian", async function () {
      const { registry, lab } = await networkHelpers.loadFixture(deployRegistry);
      const claim = input();

      await expect(registry.connect(lab).registerDiamond(claim))
        .to.emit(registry, "DiamondRegistered")
        .withArgs(1n, lab.address, claim.inscriptionId, claim.origin, claim.caratMilli)
        .and.to.emit(registry, "DiamondDetails")
        .withArgs(1n, claim.color, claim.clarity, claim.cut, claim.treatment);

      const diamond = await registry.getDiamond(1);
      expect(diamond.lab).to.equal(lab.address);
      expect(diamond.custodian).to.equal(lab.address);
      expect(diamond.reportHash).to.equal(REPORT_HASH);
      expect(diamond.origin).to.equal(1n);
      expect(diamond.status).to.equal(0n);
      expect(diamond.exists).to.equal(true);
    });

    it("rejects registration by an account without the lab role", async function () {
      const { registry, outsider } = await networkHelpers.loadFixture(deployRegistry);
      await expect(registry.connect(outsider).registerDiamond(input()))
        .to.be.revertedWith("Not a lab");
    });

    it("rejects a lab that does not also have the custodian role", async function () {
      const { registry, secondLab } = await networkHelpers.loadFixture(deployRegistry);
      await registry.grantRole(LAB_ROLE, secondLab.address);
      await expect(registry.connect(secondLab).registerDiamond(input()))
        .to.be.revertedWith("Lab must be custodian");
    });

    for (const inscriptionId of ["", "gia-123", "GIA 123", "A".repeat(65), "GIA-💎"]) {
      it(`rejects malformed inscription ${JSON.stringify(inscriptionId)}`, async function () {
        const { registry, lab } = await networkHelpers.loadFixture(deployRegistry);
        await expect(registry.connect(lab).registerDiamond(input({ inscriptionId })))
          .to.be.revertedWith("Bad inscription");
      });
    }

    for (const caratMilli of [0, 1_000_001]) {
      it(`rejects out-of-range carat value ${caratMilli}`, async function () {
        const { registry, lab } = await networkHelpers.loadFixture(deployRegistry);
        await expect(registry.connect(lab).registerDiamond(input({ caratMilli })))
          .to.be.revertedWith("Carat out of range");
      });
    }

    it("rejects an empty report hash", async function () {
      const { registry, lab } = await networkHelpers.loadFixture(deployRegistry);
      await expect(registry.connect(lab).registerDiamond(input({ reportHash: ethers.ZeroHash })))
        .to.be.revertedWith("Empty report hash");
    });

    it("rejects duplicate inscriptions and report hashes for the same lab", async function () {
      const { registry, lab } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await expect(registry.connect(lab).registerDiamond(input()))
        .to.be.revertedWith("Duplicate inscription");
      await expect(registry.connect(lab).registerDiamond(input({ inscriptionId: "GIA-2467892" })))
        .to.be.revertedWith("Duplicate report");
    });

    it("allows different labs to use the same inscription and report hash", async function () {
      const { registry, lab, secondLab } = await networkHelpers.loadFixture(deployRegistry);
      await registry.grantRole(LAB_ROLE, secondLab.address);
      await registry.grantRole(CUSTODIAN_ROLE, secondLab.address);
      await registry.connect(lab).registerDiamond(input());
      await registry.connect(secondLab).registerDiamond(input());
      expect(await registry.findByInscription(lab.address, "GIA-2467891")).to.equal(1n);
      expect(await registry.findByInscription(secondLab.address, "GIA-2467891")).to.equal(2n);
    });

    it("returns zero for an unknown valid inscription and rejects a malformed lookup", async function () {
      const { registry, lab } = await networkHelpers.loadFixture(deployRegistry);
      expect(await registry.findByInscription(lab.address, "UNKNOWN-1")).to.equal(0n);
      await expect(registry.findByInscription(lab.address, "unknown"))
        .to.be.revertedWith("Bad inscription");
    });
  });

  describe("signed registration", function () {
    it("accepts a lab signature submitted by a relayer and blocks replay", async function () {
      const { registry, lab, relayer } = await networkHelpers.loadFixture(deployRegistry);
      const claim = input();
      const signed = await signRegistration(registry, lab, claim);
      await expect(registry.connect(relayer).registerWithSignature(
        lab.address, claim, signed.nonce, signed.deadline, signed.signature,
      )).to.emit(registry, "RegistrationRelayed")
        .withArgs(1n, lab.address, relayer.address);
      expect((await registry.getDiamond(1)).custodian).to.equal(lab.address);
      await expect(registry.connect(relayer).registerWithSignature(
        lab.address, claim, signed.nonce, signed.deadline, signed.signature,
      )).to.be.revertedWith("Nonce used");
    });

    it("rejects an expired signature", async function () {
      const { registry, lab, relayer } = await networkHelpers.loadFixture(deployRegistry);
      const latestBlock = await ethers.provider.getBlock("latest");
      const claim = input();
      const signed = await signRegistration(registry, lab, claim, {
        deadline: BigInt(latestBlock.timestamp - 1),
      });
      await expect(registry.connect(relayer).registerWithSignature(
        lab.address, claim, signed.nonce, signed.deadline, signed.signature,
      )).to.be.revertedWith("Signature expired");
    });

    it("rejects changes to any signed claim field", async function () {
      const { registry, lab, relayer } = await networkHelpers.loadFixture(deployRegistry);
      const claim = input();
      const signed = await signRegistration(registry, lab, claim);
      const mutations = [
        { inscriptionId: "GIA-9999999" },
        { reportHash: ethers.keccak256(ethers.toUtf8Bytes("changed-report")) },
        { origin: 2 },
        { caratMilli: 999 },
        { color: "D" },
        { clarity: "IF" },
        { cut: "Good" },
        { treatment: "Heat" },
      ];
      for (const mutation of mutations) {
        await expect(registry.connect(relayer).registerWithSignature(
          lab.address, input(mutation), signed.nonce, signed.deadline, signed.signature,
        )).to.be.revertedWith("Bad signature");
      }
    });

    it("rejects a signature made for another chain", async function () {
      const { registry, lab, relayer } = await networkHelpers.loadFixture(deployRegistry);
      const chainId = (await ethers.provider.getNetwork()).chainId;
      const claim = input();
      const signed = await signRegistration(registry, lab, claim, { chainId: chainId + 1n });
      await expect(registry.connect(relayer).registerWithSignature(
        lab.address, claim, signed.nonce, signed.deadline, signed.signature,
      )).to.be.revertedWith("Bad signature");
    });

    it("rejects a signature made for another contract", async function () {
      const { registry, lab, relayer, outsider } = await networkHelpers.loadFixture(deployRegistry);
      const claim = input();
      const signed = await signRegistration(registry, lab, claim, {
        verifyingContract: outsider.address,
      });
      await expect(registry.connect(relayer).registerWithSignature(
        lab.address, claim, signed.nonce, signed.deadline, signed.signature,
      )).to.be.revertedWith("Bad signature");
    });

    it("rejects a valid signature from an account without the lab role", async function () {
      const { registry, outsider, relayer } = await networkHelpers.loadFixture(deployRegistry);
      const claim = input();
      const signed = await signRegistration(registry, outsider, claim);
      await expect(registry.connect(relayer).registerWithSignature(
        outsider.address, claim, signed.nonce, signed.deadline, signed.signature,
      )).to.be.revertedWith("Not a lab");
    });

    it("rechecks the lab role when a signed registration is submitted", async function () {
      const { registry, lab, relayer } = await networkHelpers.loadFixture(deployRegistry);
      const claim = input();
      const signed = await signRegistration(registry, lab, claim);
      await registry.revokeRole(LAB_ROLE, lab.address);
      await expect(registry.connect(relayer).registerWithSignature(
        lab.address, claim, signed.nonce, signed.deadline, signed.signature,
      )).to.be.revertedWith("Not a lab");
    });

    it("rechecks the lab's custodian role when a signed registration is submitted", async function () {
      const { registry, lab, relayer } = await networkHelpers.loadFixture(deployRegistry);
      const claim = input();
      const signed = await signRegistration(registry, lab, claim);
      await registry.revokeRole(CUSTODIAN_ROLE, lab.address);
      await expect(registry.connect(relayer).registerWithSignature(
        lab.address, claim, signed.nonce, signed.deadline, signed.signature,
      )).to.be.revertedWith("Lab must be custodian");
    });

    it("creates equivalent provenance through direct and signed registration", async function () {
      const { registry, lab, secondLab, relayer } =
        await networkHelpers.loadFixture(deployRegistry);
      const claim = input();
      await registry.grantRole(LAB_ROLE, secondLab.address);
      await registry.grantRole(CUSTODIAN_ROLE, secondLab.address);

      await registry.connect(lab).registerDiamond(claim);
      const signed = await signRegistration(registry, secondLab, claim);
      await registry.connect(relayer).registerWithSignature(
        secondLab.address, claim, signed.nonce, signed.deadline, signed.signature,
      );

      const direct = await registry.getDiamond(1);
      const relayed = await registry.getDiamond(2);
      expect(relayed.reportHash).to.equal(direct.reportHash);
      expect(relayed.metadataHash).to.equal(direct.metadataHash);
      expect(relayed.caratMilli).to.equal(direct.caratMilli);
      expect(relayed.origin).to.equal(direct.origin);
      expect(relayed.status).to.equal(direct.status);
      expect(direct.custodian).to.equal(lab.address);
      expect(relayed.custodian).to.equal(secondLab.address);
    });

    it("allows a lab to invalidate an unused nonce", async function () {
      const { registry, lab, relayer } = await networkHelpers.loadFixture(deployRegistry);
      const claim = input();
      const signed = await signRegistration(registry, lab, claim);
      await expect(registry.connect(lab).invalidateNonce(signed.nonce))
        .to.emit(registry, "NonceInvalidated").withArgs(lab.address, signed.nonce);
      await expect(registry.connect(relayer).registerWithSignature(
        lab.address, claim, signed.nonce, signed.deadline, signed.signature,
      )).to.be.revertedWith("Nonce used");
      await expect(registry.connect(lab).invalidateNonce(signed.nonce))
        .to.be.revertedWith("Nonce used");
    });

    it("produces the same EIP-712 digest as ethers", async function () {
      const { registry, lab } = await networkHelpers.loadFixture(deployRegistry);
      const claim = input();
      const signed = await signRegistration(registry, lab, claim);
      expect(await registry.registrationDigest(
        lab.address, claim, signed.nonce, signed.deadline,
      )).to.equal(ethers.TypedDataEncoder.hash(signed.domain, TYPES, signed.value));
    });
  });

  describe("custody transfers", function () {
    it("requires recipient consent and records the accepted transfer", async function () {
      const { registry, lab, manufacturer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await expect(registry.connect(lab).proposeTransfer(1, manufacturer.address))
        .to.emit(registry, "TransferProposed").withArgs(1n, lab.address, manufacturer.address);
      expect(await registry.pendingTo(1)).to.equal(manufacturer.address);
      await expect(registry.connect(manufacturer).acceptTransfer(1))
        .to.emit(registry, "TransferAccepted").withArgs(1n, lab.address, manufacturer.address);
      expect((await registry.getDiamond(1)).custodian).to.equal(manufacturer.address);
      expect(await registry.pendingTo(1)).to.equal(ethers.ZeroAddress);
    });

    it("rejects proposals by a non-custodian", async function () {
      const { registry, lab, manufacturer, retailer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await expect(registry.connect(manufacturer).proposeTransfer(1, retailer.address))
        .to.be.revertedWith("Not custodian");
    });

    it("rejects invalid or unauthorized recipients", async function () {
      const { registry, lab, outsider } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await expect(registry.connect(lab).proposeTransfer(1, ethers.ZeroAddress))
        .to.be.revertedWith("Invalid recipient");
      await expect(registry.connect(lab).proposeTransfer(1, lab.address))
        .to.be.revertedWith("Invalid recipient");
      await expect(registry.connect(lab).proposeTransfer(1, outsider.address))
        .to.be.revertedWith("Recipient not authorised");
    });

    it("does not allow a pending proposal to be overwritten", async function () {
      const { registry, lab, manufacturer, retailer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.connect(lab).proposeTransfer(1, manufacturer.address);
      await expect(registry.connect(lab).proposeTransfer(1, retailer.address))
        .to.be.revertedWith("Proposal already exists");
    });

    it("rejects acceptance by the wrong account", async function () {
      const { registry, lab, manufacturer, retailer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.connect(lab).proposeTransfer(1, manufacturer.address);
      await expect(registry.connect(retailer).acceptTransfer(1))
        .to.be.revertedWith("No proposal for you");
    });

    it("rechecks the recipient role at acceptance", async function () {
      const { registry, lab, manufacturer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.connect(lab).proposeTransfer(1, manufacturer.address);
      await registry.revokeRole(CUSTODIAN_ROLE, manufacturer.address);
      await expect(registry.connect(manufacturer).acceptTransfer(1))
        .to.be.revertedWith("Recipient not authorised");
    });

    it("rechecks the sender role at proposal and acceptance", async function () {
      const { registry, lab, manufacturer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.revokeRole(CUSTODIAN_ROLE, lab.address);
      await expect(registry.connect(lab).proposeTransfer(1, manufacturer.address))
        .to.be.revertedWith("Sender not authorised");
      await registry.grantRole(CUSTODIAN_ROLE, lab.address);
      await registry.connect(lab).proposeTransfer(1, manufacturer.address);
      await registry.revokeRole(CUSTODIAN_ROLE, lab.address);
      await expect(registry.connect(manufacturer).acceptTransfer(1))
        .to.be.revertedWith("Sender not authorised");
    });

    it("allows the sender to cancel and the recipient to reject", async function () {
      const { registry, lab, manufacturer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.connect(lab).proposeTransfer(1, manufacturer.address);
      await expect(registry.connect(lab).cancelTransfer(1))
        .to.emit(registry, "TransferCancelled").withArgs(1n, lab.address);
      expect(await registry.pendingTo(1)).to.equal(ethers.ZeroAddress);
      await registry.connect(lab).proposeTransfer(1, manufacturer.address);
      await expect(registry.connect(manufacturer).rejectTransfer(1))
        .to.emit(registry, "TransferRejected").withArgs(1n, manufacturer.address);
      expect(await registry.pendingTo(1)).to.equal(ethers.ZeroAddress);
    });

    it("keeps provenance fields unchanged across multiple transfers", async function () {
      const { registry, lab, manufacturer, retailer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      const original = await registry.getDiamond(1);
      await registry.connect(lab).proposeTransfer(1, manufacturer.address);
      await registry.connect(manufacturer).acceptTransfer(1);
      await registry.connect(manufacturer).proposeTransfer(1, retailer.address);
      await registry.connect(retailer).acceptTransfer(1);
      const transferred = await registry.getDiamond(1);
      expect(transferred.lab).to.equal(original.lab);
      expect(transferred.reportHash).to.equal(original.reportHash);
      expect(transferred.metadataHash).to.equal(original.metadataHash);
      expect(transferred.origin).to.equal(original.origin);
      expect(transferred.caratMilli).to.equal(original.caratMilli);
      expect(transferred.custodian).to.equal(retailer.address);
    });
  });

  describe("quarantine lifecycle", function () {
    it("allows the issuing lab to quarantine and clears a pending transfer", async function () {
      const { registry, lab, manufacturer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.connect(lab).proposeTransfer(1, manufacturer.address);
      await expect(registry.connect(lab).quarantine(1, "Report under review"))
        .to.emit(registry, "StatusChanged")
        .withArgs(1n, 1n, lab.address, "Report under review");
      expect((await registry.getDiamond(1)).status).to.equal(1n);
      expect(await registry.pendingTo(1)).to.equal(ethers.ZeroAddress);
    });

    it("rejects quarantine by another lab or a lab whose role was revoked", async function () {
      const { registry, lab, secondLab } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.grantRole(LAB_ROLE, secondLab.address);
      await expect(registry.connect(secondLab).quarantine(1, "Not my record"))
        .to.be.revertedWith("Not allowed");
      await registry.revokeRole(LAB_ROLE, lab.address);
      await expect(registry.connect(lab).quarantine(1, "Role revoked"))
        .to.be.revertedWith("Not allowed");
    });

    it("freezes transfers while a record is quarantined", async function () {
      const { registry, lab, manufacturer } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.connect(lab).quarantine(1, "Review");
      await expect(registry.connect(lab).proposeTransfer(1, manufacturer.address))
        .to.be.revertedWith("Record not active");
      await expect(registry.connect(manufacturer).acceptTransfer(1))
        .to.be.revertedWith("Record not active");
    });

    it("requires an admin to resolve or revoke a quarantine", async function () {
      const { registry, lab, outsider } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.connect(lab).quarantine(1, "Review");
      await expect(registry.connect(outsider).resolveQuarantine(1, "Clear"))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
      await expect(registry.connect(outsider).revokeRecord(1, "Fraud"))
        .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount");
    });

    it("allows an admin to resolve a quarantine", async function () {
      const { registry, admin, lab } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await registry.connect(lab).quarantine(1, "Review");
      await expect(registry.connect(admin).resolveQuarantine(1, "Review cleared"))
        .to.emit(registry, "StatusChanged")
        .withArgs(1n, 0n, admin.address, "Review cleared");
      expect((await registry.getDiamond(1)).status).to.equal(0n);
    });

    it("requires quarantine before revocation and makes revocation terminal", async function () {
      const { registry, admin, lab } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await expect(registry.connect(admin).revokeRecord(1, "Fraud"))
        .to.be.revertedWith("Quarantine first");
      await registry.connect(lab).quarantine(1, "Fraud suspected");
      await expect(registry.connect(admin).revokeRecord(1, "Fraud confirmed"))
        .to.emit(registry, "StatusChanged")
        .withArgs(1n, 2n, admin.address, "Fraud confirmed");
      expect((await registry.getDiamond(1)).status).to.equal(2n);
      await expect(registry.connect(admin).resolveQuarantine(1, "Undo"))
        .to.be.revertedWith("Not quarantined");
      await expect(registry.connect(lab).quarantine(1, "Again"))
        .to.be.revertedWith("Not active");
    });

    it("requires a non-empty reason for every status change", async function () {
      const { registry, admin, lab } = await networkHelpers.loadFixture(deployRegistry);
      await registry.connect(lab).registerDiamond(input());
      await expect(registry.connect(lab).quarantine(1, ""))
        .to.be.revertedWith("Reason required");
      await registry.connect(lab).quarantine(1, "Review");
      await expect(registry.connect(admin).resolveQuarantine(1, ""))
        .to.be.revertedWith("Reason required");
      await expect(registry.connect(admin).revokeRecord(1, ""))
        .to.be.revertedWith("Reason required");
    });
  });
});
