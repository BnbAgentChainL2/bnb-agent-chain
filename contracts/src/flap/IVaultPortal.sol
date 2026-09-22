// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

import {IPortalTypes} from "./IPortal.sol";

/// @title IVaultPortalTypes
/// @notice Type definitions for the VaultPortal contract
/// @dev Contains all structs and custom types used by VaultPortal
interface IVaultPortalTypes {
    /// @notice Risk level classification for vault audits (8 bits)
    /// @dev Used to represent the security assessment of a vault or factory
    enum RiskLevel {
        UNVERIFIED, // 0 - Not yet verified/audited
        LOW_RISK, // 1 - Low risk
        LOW_MEDIUM_RISK, // 2 - Low to medium risk
        MEDIUM_RISK, // 3 - Medium risk
        HIGH_RISK // 4 - High risk
    }

    /// @notice Category classification for vaults (8 bits)
    /// @dev Used to categorize vaults by their type or functionality
    enum VaultCategory {
        NONE, // 0 - Not in any category (default)
        TYPE_AI_ORACLE_POWERED // 1 - AI Oracle powered vaults
    }

    /// @notice Permission policy for a vault factory (8 bits)
    /// @dev Controls who is allowed to use this factory to launch tokens
    enum FactoryPermissionPolicy {
        OPEN, // 0 - Anyone can use this factory to launch tokens (default)
        TIME_DEPENDENT, // 1 - Only the designated developer may launch during an exclusive window; open to all afterwards
        DISABLED // 2 - No one can use this factory to launch tokens
    }

    /// @notice Information about a registered vault factory
    /// @dev Packed into a single storage slot for gas efficiency
    /// @param enabled Whether this factory can be used to create new vaults
    /// @param official Whether vaults created by this factory are marked as official/endorsed
    /// @param riskLevel The risk level classification from audit
    /// @param category The category classification for vaults from this factory (1 byte)
    /// @param permissionPolicy The permission policy controlling who may launch tokens via this factory (1 byte)
    /// @param reserved Reserved space for future upgrades (27 bytes)
    struct VaultFactoryInfo {
        bool enabled;
        bool official;
        RiskLevel riskLevel;
        VaultCategory category;
        FactoryPermissionPolicy permissionPolicy;
        bytes27 reserved;
    }

    /// @notice Packed vault information stored in contract storage
    /// @dev Uses three storage slots (64 bytes total)
    /// @param vault The address of the vault contract (20 bytes)
    /// @param vaultFactory The address of the vault factory that created this vault (20 bytes)
    /// @param adapter The address of the adapter contract for legacy vaults (20 bytes)
    /// @param isOfficial Whether this vault is marked as official/endorsed (1 byte)
    /// @param riskLevel The risk level classification from audit (1 byte)
    /// @param category The category classification for this vault (1 byte)
    struct VaultedTaxTokenInfo {
        // slot 0
        address vault;
        bool isOfficial;
        RiskLevel riskLevel;
        VaultCategory category;
        bytes9 reserved0;
        // slot 1
        address vaultFactory;
        bytes12 reserved1;
        // slot 2
        address adapter;
        bytes12 reserved2;
    }

    /// @notice Audit report for a tax token
    /// @param auditor The address of the auditor who submitted this report
    /// @param riskLevel The risk level classification from this audit
    /// @param ipfsCid The IPFS CID of the audit report document
    struct AuditReport {
        address auditor;
        RiskLevel riskLevel;
        string ipfsCid;
    }

    /// @notice Complete vault information returned to external callers
    /// @dev This struct is used for view functions and includes human-readable description
    /// @param vault The address of the vault contract
    /// @param vaultFactory The address of the vault factory that created this vault (zero address if unknown)
    /// @param description Human-readable description of the vault's purpose and functionality
    /// @param isOfficial Whether this vault is marked as official/endorsed by the protocol
    /// @param riskLevel The risk level classification from audit
    struct VaultInfo {
        address vault;
        address vaultFactory;
        string description;
        bool isOfficial;
        RiskLevel riskLevel;
    }

    /// @notice Parameters required to create a new tax token with an associated vault
    /// @dev All parameters are passed as a single struct to avoid stack-too-deep errors
    /// @param name The name of the tax token (e.g., "MyToken")
    /// @param symbol The symbol of the tax token (e.g., "MTK")
    /// @param meta Metadata URI or string for additional token information
    /// @param dexThresh The DEX supply threshold type
    /// @param salt A unique salt for deterministic address generation (must produce vanity suffix)
    /// @param taxRate The tax rate in basis points (e.g., 100 = 1%, max 1000 = 10%)
    /// @param migratorType The migrator type (see MigratorType enum)
    /// @param quoteToken The token used for initial liquidity (address(0) for native token)
    /// @param quoteAmt The amount of quote token to provide as initial liquidity
    /// @param permitData The optional permit data for the quote token
    /// @param extensionID The ID of the extension to be used for the new token if not zero
    /// @param extensionData Additional extension specific data
    /// @param dexId The preferred DEX ID for the token
    /// @param lpFeeProfile The preferred V3 LP fee profile for the token
    /// @param taxDuration Tax duration in seconds (max: 100 years)
    /// @param antiFarmerDuration Anti-farmer duration in seconds (max: 1 year)
    /// @param mktBps Market allocation basis points (to beneficiary)
    /// @param deflationBps Deflation basis points (burned)
    /// @param dividendBps Dividend basis points (to dividend contract)
    /// @param lpBps Liquidity provision basis points (LP to dead address)
    /// @param minimumShareBalance Minimum balance for dividend eligibility
    /// @param vaultFactory The address of the vault factory to use for creating the vault (any factory is allowed; unregistered/disabled factories result in unverified vaults)
    /// @param vaultData Encoded data specific to the vault type being created
    struct NewTaxTokenWithVaultParams {
        string name;
        string symbol;
        string meta;
        IPortalTypes.DexThreshType dexThresh;
        bytes32 salt;
        uint16 taxRate;
        IPortalTypes.MigratorType migratorType;
        address quoteToken;
        uint256 quoteAmt;
        bytes permitData;
        bytes32 extensionID;
        bytes extensionData;
        IPortalTypes.DEXId dexId;
        IPortalTypes.V3LPFeeProfile lpFeeProfile;
        uint64 taxDuration;
        uint64 antiFarmerDuration;
        uint16 mktBps;
        uint16 deflationBps;
        uint16 dividendBps;
        uint16 lpBps;
        uint256 minimumShareBalance;
        address vaultFactory;
        bytes vaultData;
    }

    /// @notice Parameters required to create a new V3 tax token with an associated vault
    /// @dev tokenVersion must be TOKEN_TAXED_V3; if it is not, the implementation reverts with FeatureDisabled
    struct NewTokenV6WithVaultParams {
        string name;
        string symbol;
        string meta;
        IPortalTypes.DexThreshType dexThresh;
        bytes32 salt;
        IPortalTypes.MigratorType migratorType;
        address quoteToken;
        uint256 quoteAmt;
        bytes permitData;
        bytes32 extensionID;
        bytes extensionData;
        IPortalTypes.DEXId dexId;
        IPortalTypes.V3LPFeeProfile lpFeeProfile;
        // V3 tax fields
        uint16 buyTaxRate;
        uint16 sellTaxRate;
        uint64 taxDuration;
        uint64 antiFarmerDuration;
        uint16 mktBps;
        uint16 deflationBps;
        uint16 dividendBps;
        uint16 lpBps;
        uint256 minimumShareBalance;
        address dividendToken;
        address commissionReceiver;
        /// The token version to use (must be TOKEN_TAXED_V3, otherwise reverts with FeatureDisabled)
        IPortalTypes.TokenVersion tokenVersion;
        // vault fields
        address vaultFactory;
        bytes vaultData;
    }

    /* ========== EVENTS ========== */

    /// @notice Emitted when a new tax token with an associated vault is successfully created
    /// @param token The address of the newly deployed tax token
    /// @param vault The address of the newly created vault that will receive tax revenue
    /// @param vaultFactory The vault factory address that was used to create the vault
    event FlapTaxVaultTokenCreated(address indexed token, address indexed vault, address indexed vaultFactory);

    /// @notice Emitted when a vault factory is registered or its configuration is updated
    /// @param factory The address of the vault factory being registered/updated
    /// @param enabled Whether the factory is enabled for creating new vaults
    /// @param official Whether vaults from this factory should be marked as official
    /// @param riskLevel The risk level classification for vaults from this factory
    event FlapTaxVaultFactoryRegistered(address factory, bool enabled, bool official, RiskLevel riskLevel);

    /// @notice Emitted when a vault factory's category is set during registration or update
    /// @param factory The address of the vault factory
    /// @param category The category classification for vaults from this factory
    event FlapTaxVaultFactoryCategorySet(address factory, VaultCategory category);

    /// @notice Emitted when a vault factory's permission policy is updated
    /// @param factory The address of the vault factory
    /// @param policy The new permission policy
    event FactoryPermissionPolicySet(address indexed factory, FactoryPermissionPolicy policy);

    /// @notice Emitted when an adapter is registered for a legacy tax token
    /// @param taxToken The address of the tax token
    /// @param adapter The address of the adapter contract
    event AdapterRegistered(address indexed taxToken, address indexed adapter);

    /// @notice Emitted when a new audit report is submitted
    /// @param taxToken The address of the tax token being audited
    /// @param auditor The address of the auditor
    /// @param riskLevel The risk level classification from this audit
    /// @param ipfsCid The IPFS CID of the audit report
    event AuditReportSubmitted(address indexed taxToken, address indexed auditor, RiskLevel riskLevel, string ipfsCid);

    /// @notice Emitted when a new audit report is submitted for a vault factory
    /// @param factory The address of the vault factory being audited
    /// @param auditor The address of the auditor
    /// @param riskLevel The risk level classification from this audit
    /// @param ipfsCid The IPFS CID of the audit report
    event FactoryAuditReportSubmitted(
        address indexed factory, address indexed auditor, RiskLevel riskLevel, string ipfsCid
    );

    /// @notice Emitted when a vault's category is updated
    /// @param taxToken The address of the tax token
    /// @param category The new category
    event VaultCategoryUpdated(address indexed taxToken, VaultCategory category);

    /// @notice Emitted when a factory's category is updated
    /// @param factory The address of the vault factory
    /// @param category The new category
    event FactoryCategoryUpdated(address indexed factory, VaultCategory category);

    /// @notice Emitted when a token's stored vault address is refreshed to match the on-chain market wallet.
    /// @param token The address of the tax token
    /// @param oldVault The previously stored vault address
    /// @param newVault The updated vault address (current on-chain market wallet)
    event TokenVaultRefreshed(address indexed token, address indexed oldVault, address indexed newVault);

    /* ========== ERRORS ========== */

    /// @notice Thrown when the provided tax rate is invalid (0 or > 1000 basis points)
    /// @param taxRate The invalid tax rate that was provided
    error InvalidTaxRate(uint256 taxRate);

    /// @notice Thrown when mktBps is invalid (must be > 0)
    error InvalidMktBps();

    /// @notice Thrown when an unsupported quote token is specified
    /// @param quoteToken The address of the unsupported quote token
    error UnsupportedQuoteToken(address quoteToken);

    /// @notice Thrown when attempting to use a vault factory that is not registered
    /// @param factory The address of the unregistered vault factory
    error VaultFactoryNotRegistered(address factory);

    /// @notice Thrown when the predicted token address does not match the required vanity suffix
    /// @param predictedAddress The predicted address that failed the vanity check
    error InvalidVanity(address predictedAddress);

    /// @notice Thrown when trying to get vault info for a token that has no associated vault
    /// @param taxToken The address of the tax token with no vault
    error VaultNotFound(address taxToken);

    /// @notice Thrown when token address does not match predicted address
    error TokenAddressMismatch();

    /// @notice Thrown when BNB transfer fails
    error BnbTransferFailed();

    /// @notice Thrown when a non-V3 tax token version is specified (only TOKEN_TAXED_V3 is allowed)
    error OnlyV3TaxTokenAllowed();

    /// @notice Thrown when a requested feature is not yet enabled
    error FeatureDisabled();

    /// @notice Thrown when portal address is zero
    error ZeroPortalAddress();

    /// @notice Thrown when token implementation address is zero
    error ZeroTokenImplAddress();

    /// @notice Thrown when trying to perform an operation on a non-existent token
    /// @param taxToken The address of the non-existent tax token
    error TokenNotFound(address taxToken);

    /// @notice error when user is rate limited from creating tokens
    /// @param user The address that is rate limited
    /// @param lastCreationTime The timestamp of the user's last successful token creation
    error RateLimitExceeded(address user, uint256 lastCreationTime);
}

/// @title IVaultPortal
/// @notice Interface for the VaultPortal contract that manages vault creation for tax tokens
/// @dev VaultPortal acts as a registry and factory orchestrator for different vault types
/// @dev It coordinates the creation of tax tokens with their associated revenue vaults
interface IVaultPortal is IVaultPortalTypes {
    /* ========== FUNCTIONS ========== */

    /// @notice Get information about a registered vault factory
    /// @param factory The address of the vault factory
    /// @return enabled Whether this factory can be used to create new vaults
    /// @return official Whether vaults created by this factory are marked as official/endorsed
    /// @return riskLevel The risk level classification for vaults from this factory
    /// @return reserved Reserved space for future upgrades (29 bytes)
    function vaultFactories(address factory)
        external
        view
        returns (bool enabled, bool official, RiskLevel riskLevel, bytes29 reserved);
    /* ========== FUNCTIONS ========== */

    /// @notice Create a new tax token with an associated vault in a single transaction
    /// @dev This function orchestrates the creation of both the vault and the tax token
    /// @dev The vault is created first using the predicted token address, then the token is created
    /// @dev Requires msg.value to match or exceed the quoteAmt for initial liquidity
    /// @dev Any vault factory can be used. If the factory is not registered or is disabled,
    ///      the vault will be treated as unofficial with UNVERIFIED risk level
    /// @param params The parameters for creating the tax token and vault
    /// @return token The address of the newly created tax token
    function newTaxTokenWithVault(NewTaxTokenWithVaultParams calldata params) external payable returns (address token);

    /// @notice Create a new tax token via Portal's newTokenV6 with an associated vault in a single transaction
    /// @dev Only TOKEN_TAXED_V3 is currently supported as tokenVersion; any other version reverts with FeatureDisabled.
    /// @param params The parameters for creating the tax token and vault (mirrors NewTokenV6Params, minus beneficiary)
    /// @return token The address of the newly created tax token
    function newTokenV6WithVault(NewTokenV6WithVaultParams calldata params) external payable returns (address token);

    /// @notice Predict the address of a tax token V1 given a salt
    /// @dev Uses CREATE2 deterministic address prediction
    /// @dev Useful for generating valid salts that produce the required vanity suffix
    /// @param salt The salt for deterministic deployment
    /// @return predictedAddress The predicted address of the tax token
    function predictTaxTokenV1Address(bytes32 salt) external view returns (address predictedAddress);

    /// @notice Get the complete vault information for a tax token
    /// @dev Reverts if no vault is found for the given tax token
    /// @dev Attempts to fetch the vault's description by calling its description() function
    /// @param taxToken The address of the tax token
    /// @return info The VaultInfo struct containing complete vault details
    function getVault(address taxToken) external view returns (VaultInfo memory info);

    /// @notice Attempt to get vault information for a tax token without reverting
    /// @dev First checks the internal mapping, then falls back to searching the Portal
    /// @dev For fallback results, isOfficial and isVerified will always be false
    /// @param taxToken The address of the tax token
    /// @return found Whether a vault was found for this tax token
    /// @return info The VaultInfo struct (empty if not found)
    function tryGetVault(address taxToken) external view returns (bool found, VaultInfo memory info);

    /// @notice Register a new vault factory or update an existing one (backward-compatible overload)
    /// @dev Only accounts with VAULT_ADMIN_ROLE can call this function
    /// @dev Allows enabling/disabling factories and updating their official/riskLevel status
    /// @dev Category defaults to VaultCategory.NONE
    /// @param factory The address of the vault factory to register/update
    /// @param enabled Whether the factory should be enabled for creating new vaults
    /// @param official Whether vaults from this factory should be marked as official
    /// @param riskLevel The risk level classification for vaults from this factory
    function registerVaultFactory(address factory, bool enabled, bool official, RiskLevel riskLevel) external;

    /// @notice Register a new vault factory or update an existing one with a specific category
    /// @dev Only accounts with VAULT_ADMIN_ROLE can call this function
    /// @dev Allows enabling/disabling factories and updating their official/riskLevel/category status
    /// @param factory The address of the vault factory to register/update
    /// @param enabled Whether the factory should be enabled for creating new vaults
    /// @param official Whether vaults from this factory should be marked as official
    /// @param riskLevel The risk level classification for vaults from this factory
    /// @param category The category classification for vaults from this factory
    function registerVaultFactory(
        address factory,
        bool enabled,
        bool official,
        RiskLevel riskLevel,
        VaultCategory category
    ) external;

    /// @notice Register an adapter for a legacy tax token vault
    /// @dev Only accounts with AUDITOR_ROLE can call this function
    /// @dev The adapter must implement the VaultBase interface for compatibility
    /// @param taxToken The address of the tax token
    /// @param adapter The address of the adapter contract
    function registerAdapter(address taxToken, address adapter) external;

    /// @notice Submit a new audit report for a tax token
    /// @dev Only accounts with AUDITOR_ROLE can call this function
    /// @dev The tax token must exist (have a vault or adapter registered)
    /// @dev This may change the risk level of the token
    /// @param taxToken The address of the tax token being audited
    /// @param riskLevel The risk level classification from this audit
    /// @param ipfsCid The IPFS CID of the audit report document
    function submitAuditReport(address taxToken, RiskLevel riskLevel, string calldata ipfsCid) external;

    /// @notice Submit a new audit report for a vault factory
    /// @dev Only accounts with VAULT_ADMIN_ROLE can call this function
    /// @dev The factory should be registered or have existing audit reports
    /// @param factory The address of the vault factory being audited
    /// @param riskLevel The risk level classification from this audit
    /// @param ipfsCid The IPFS CID of the audit report document
    function submitFactoryAuditReport(address factory, RiskLevel riskLevel, string calldata ipfsCid) external;

    /// @notice Get recent audit reports for a tax token with pagination
    /// @dev Returns reports starting from the most recent (end of array)
    /// @dev If the token has no audit reports, falls back to its factory's audit reports
    /// @param taxToken The address of the tax token
    /// @param offset The number of reports to skip from the end (0 = most recent)
    /// @param limit The maximum number of reports to return
    /// @return reports The array of audit reports
    /// @return total The total number of audit reports for this token
    function getAuditReports(address taxToken, uint256 offset, uint256 limit)
        external
        view
        returns (AuditReport[] memory reports, uint256 total);

    /// @notice Get the category of a vault
    /// @param taxToken The tax token address
    /// @return category The category of the vault
    function getVaultCategory(address taxToken) external view returns (VaultCategory category);

    /// @notice Get the category of a vault factory
    /// @param factory The vault factory address
    /// @return category The category of the factory
    function getFactoryCategory(address factory) external view returns (VaultCategory category);

    /// @notice Get the permission policy for a vault factory
    /// @param factory The vault factory address
    /// @return policy  The active FactoryPermissionPolicy enum value
    /// @return policyData  Raw 32-byte slot holding policy-specific data.
    ///         For TIME_DEPENDENT: top 64 bits = expirationTime (unix timestamp),
    ///         next 160 bits = developer address, remaining 32 bits = zero.
    /// @return description  Human-readable explanation of the current policy
    function getFactoryPolicy(address factory)
        external
        view
        returns (FactoryPermissionPolicy policy, bytes32 policyData, string memory description);

    /// @notice Set the category of a vault
    /// @dev Only accounts with VAULT_ADMIN_ROLE can call this function
    /// @param taxToken The tax token address
    /// @param category The new category
    function setVaultCategory(address taxToken, VaultCategory category) external;

    /// @notice Set the category of a vault factory
    /// @dev Only accounts with VAULT_ADMIN_ROLE can call this function
    /// @param factory The vault factory address
    /// @param category The new category
    function setFactoryCategory(address factory, VaultCategory category) external;

    /// @notice Syncs the stored vault address for `token` with the current on-chain market wallet.
    /// @dev Only callable by AUDITOR_ROLE.
    ///      If the token has no entry in taxVaults, the call is silently ignored.
    ///      If the on-chain market wallet differs from the stored vault, the stored vault is updated
    ///      and a TokenVaultRefreshed event is emitted.
    /// @param token The tax token address to refresh.
    function refreshTokenVault(address token) external;

    /// @notice Reset a factory's permission policy back to OPEN (unrestricted access).
    /// @dev Only callable by AUDITOR_ROLE.  Clears any stored policy data (expiration / developer).
    /// @param factory The vault factory address.
    function resetFactoryPolicy(address factory) external;
}
