// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/access/AccessControl.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

contract DiamondRegistry is AccessControl, EIP712 {
    bytes32 public constant LAB_ROLE = keccak256("LAB_ROLE");
    bytes32 public constant CUSTODIAN_ROLE = keccak256("CUSTODIAN_ROLE");

    bytes32 private constant DETAILS_TYPEHASH = keccak256(
        "Details(string color,string clarity,string cut,string treatment)"
    );
    bytes32 private constant CLAIM_TYPEHASH = keccak256(
        "DiamondClaim(string inscriptionId,bytes32 reportHash,uint8 origin,uint32 caratMilli,Details details)"
        "Details(string color,string clarity,string cut,string treatment)"
    );
    bytes32 private constant REGISTRATION_TYPEHASH = keccak256(
        "Registration(address lab,DiamondClaim claim,uint256 nonce,uint64 deadline)"
        "Details(string color,string clarity,string cut,string treatment)"
        "DiamondClaim(string inscriptionId,bytes32 reportHash,uint8 origin,uint32 caratMilli,Details details)"
    );

    enum Origin { Natural, LabGrownCVD, LabGrownHPHT }
    enum Status { Active, Quarantined, Revoked }

    struct Diamond {
        bytes32 inscriptionKey;
        bytes32 reportHash;
        bytes32 metadataHash;
        address lab;
        address custodian;
        uint64 registeredAt;
        uint32 caratMilli;
        Origin origin;
        Status status;
        bool exists;
    }

    struct RegistrationInput {
        string inscriptionId;
        bytes32 reportHash;
        Origin origin;
        uint32 caratMilli;
        string color;
        string clarity;
        string cut;
        string treatment;
    }

    uint256 public nextId = 1;

    mapping(uint256 => Diamond) private diamonds;
    mapping(uint256 => address) public pendingTo;
    mapping(bytes32 => uint256) public idByKey;
    mapping(address => mapping(bytes32 => bool)) public reportUsed;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    event DiamondRegistered(
        uint256 indexed id,
        address indexed lab,
        string inscriptionId,
        Origin origin,
        uint32 caratMilli
    );
    event DiamondDetails(
        uint256 indexed id,
        string color,
        string clarity,
        string cut,
        string treatment
    );
    event RegistrationRelayed(uint256 indexed id, address indexed lab, address indexed relayer);
    event NonceInvalidated(address indexed lab, uint256 nonce);
    event TransferProposed(uint256 indexed id, address indexed from, address indexed to);
    event TransferAccepted(uint256 indexed id, address indexed from, address indexed to);
    event TransferCancelled(uint256 indexed id, address indexed by);
    event TransferRejected(uint256 indexed id, address indexed by);
    event StatusChanged(uint256 indexed id, Status status, address indexed by, string reason);

    constructor() EIP712("DiamondProvenance", "1") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
    }

    function registerDiamond(RegistrationInput calldata r) external returns (uint256 id) {
        id = _register(msg.sender, r);
    }

    function registerWithSignature(
        address lab,
        RegistrationInput calldata r,
        uint256 nonce,
        uint64 deadline,
        bytes calldata signature
    ) external returns (uint256 id) {
        require(block.timestamp <= deadline, "Signature expired");
        require(!nonceUsed[lab][nonce], "Nonce used");

        bytes32 digest = _hashTypedDataV4(_registrationHash(lab, r, nonce, deadline));
        require(ECDSA.recover(digest, signature) == lab, "Bad signature");

        nonceUsed[lab][nonce] = true;
        id = _register(lab, r);
        emit RegistrationRelayed(id, lab, msg.sender);
    }

    function invalidateNonce(uint256 nonce) external {
        require(!nonceUsed[msg.sender][nonce], "Nonce used");
        nonceUsed[msg.sender][nonce] = true;
        emit NonceInvalidated(msg.sender, nonce);
    }

    function registrationDigest(
        address lab,
        RegistrationInput calldata r,
        uint256 nonce,
        uint64 deadline
    ) external view returns (bytes32) {
        return _hashTypedDataV4(_registrationHash(lab, r, nonce, deadline));
    }

    function proposeTransfer(uint256 id, address to) external {
        Diamond storage d = _active(id);
        require(d.custodian == msg.sender, "Not custodian");
        require(hasRole(CUSTODIAN_ROLE, msg.sender), "Sender not authorised");
        require(to != address(0) && to != msg.sender, "Invalid recipient");
        require(hasRole(CUSTODIAN_ROLE, to), "Recipient not authorised");
        require(pendingTo[id] == address(0), "Proposal already exists");

        pendingTo[id] = to;
        emit TransferProposed(id, msg.sender, to);
    }

    function acceptTransfer(uint256 id) external {
        Diamond storage d = _active(id);
        require(pendingTo[id] == msg.sender, "No proposal for you");
        require(hasRole(CUSTODIAN_ROLE, msg.sender), "Recipient not authorised");
        require(hasRole(CUSTODIAN_ROLE, d.custodian), "Sender not authorised");

        address from = d.custodian;
        d.custodian = msg.sender;
        delete pendingTo[id];
        emit TransferAccepted(id, from, msg.sender);
    }

    function cancelTransfer(uint256 id) external {
        Diamond storage d = _known(id);
        require(d.custodian == msg.sender, "Not custodian");
        require(pendingTo[id] != address(0), "No proposal");
        delete pendingTo[id];
        emit TransferCancelled(id, msg.sender);
    }

    function rejectTransfer(uint256 id) external {
        _known(id);
        require(pendingTo[id] == msg.sender, "No proposal for you");
        delete pendingTo[id];
        emit TransferRejected(id, msg.sender);
    }

    function quarantine(uint256 id, string calldata reason) external {
        Diamond storage d = _known(id);
        require(d.status == Status.Active, "Not active");
        require(bytes(reason).length > 0, "Reason required");

        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        bool isLiveIssuer = msg.sender == d.lab && hasRole(LAB_ROLE, msg.sender);
        require(isAdmin || isLiveIssuer, "Not allowed");

        d.status = Status.Quarantined;
        delete pendingTo[id];
        emit StatusChanged(id, Status.Quarantined, msg.sender, reason);
    }

    function resolveQuarantine(uint256 id, string calldata reason)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Diamond storage d = _known(id);
        require(d.status == Status.Quarantined, "Not quarantined");
        require(bytes(reason).length > 0, "Reason required");
        d.status = Status.Active;
        emit StatusChanged(id, Status.Active, msg.sender, reason);
    }

    function revokeRecord(uint256 id, string calldata reason)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        Diamond storage d = _known(id);
        require(d.status == Status.Quarantined, "Quarantine first");
        require(bytes(reason).length > 0, "Reason required");
        d.status = Status.Revoked;
        emit StatusChanged(id, Status.Revoked, msg.sender, reason);
    }

    function getDiamond(uint256 id) external view returns (Diamond memory) {
        return _known(id);
    }

    function findByInscription(address lab, string calldata inscriptionId)
        external
        view
        returns (uint256)
    {
        require(_validInscription(inscriptionId), "Bad inscription");
        return idByKey[keccak256(abi.encode(lab, inscriptionId))];
    }

    function _register(address lab, RegistrationInput calldata r) internal returns (uint256 id) {
        require(hasRole(LAB_ROLE, lab), "Not a lab");
        require(hasRole(CUSTODIAN_ROLE, lab), "Lab must be custodian");
        require(_validInscription(r.inscriptionId), "Bad inscription");
        require(r.reportHash != bytes32(0), "Empty report hash");
        require(r.caratMilli >= 1 && r.caratMilli <= 1_000_000, "Carat out of range");

        bytes32 key = keccak256(abi.encode(lab, r.inscriptionId));
        require(idByKey[key] == 0, "Duplicate inscription");
        require(!reportUsed[lab][r.reportHash], "Duplicate report");

        id = nextId++;
        idByKey[key] = id;
        reportUsed[lab][r.reportHash] = true;

        Diamond storage d = diamonds[id];
        d.inscriptionKey = key;
        d.reportHash = r.reportHash;
        d.metadataHash = _detailsHash(r);
        d.lab = lab;
        d.custodian = lab;
        d.registeredAt = uint64(block.timestamp);
        d.caratMilli = r.caratMilli;
        d.origin = r.origin;
        d.status = Status.Active;
        d.exists = true;

        emit DiamondRegistered(id, lab, r.inscriptionId, r.origin, r.caratMilli);
        emit DiamondDetails(id, r.color, r.clarity, r.cut, r.treatment);
    }

    function _detailsHash(RegistrationInput calldata r) private pure returns (bytes32) {
        return keccak256(abi.encode(
            DETAILS_TYPEHASH,
            keccak256(bytes(r.color)),
            keccak256(bytes(r.clarity)),
            keccak256(bytes(r.cut)),
            keccak256(bytes(r.treatment))
        ));
    }

    function _registrationHash(
        address lab,
        RegistrationInput calldata r,
        uint256 nonce,
        uint64 deadline
    ) private pure returns (bytes32) {
        bytes32 claimHash = keccak256(abi.encode(
            CLAIM_TYPEHASH,
            keccak256(bytes(r.inscriptionId)),
            r.reportHash,
            uint8(r.origin),
            r.caratMilli,
            _detailsHash(r)
        ));
        return keccak256(abi.encode(REGISTRATION_TYPEHASH, lab, claimHash, nonce, deadline));
    }

    function _known(uint256 id) private view returns (Diamond storage d) {
        d = diamonds[id];
        require(d.exists, "Unknown diamond");
    }

    function _active(uint256 id) private view returns (Diamond storage d) {
        d = _known(id);
        require(d.status == Status.Active, "Record not active");
    }

    function _validInscription(string calldata s) private pure returns (bool) {
        bytes calldata b = bytes(s);
        if (b.length == 0 || b.length > 64) return false;
        for (uint256 i = 0; i < b.length; i++) {
            bytes1 c = b[i];
            bool ok = (c >= 0x30 && c <= 0x39)
                   || (c >= 0x41 && c <= 0x5A)
                   || c == 0x2D;
            if (!ok) return false;
        }
        return true;
    }
}
