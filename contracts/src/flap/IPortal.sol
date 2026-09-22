// SPDX-License-Identifier: MIT

pragma solidity ^0.8.13;

import {IAccessControlUpgradeable} from "@openzeppelin-contracts-upgradeable/access/IAccessControlUpgradeable.sol";

/// @dev Magic address value for `dividendToken` in NewTokenV6Params.
///      When set to this address, the dividend token is resolved to the tax token's own address
///      after it is created. This is a sugar for devs who do not want to pre-compute the tax token
///      address (it is deterministically computed from the salt).
///      Uses a well-known non-conflicting sentinel (0xfEED...fEED) to avoid conflict with:
///        - address(0): native gas token dividend (only valid when quoteToken is also native gas)
///        - any ERC-20 address: use that token as dividend (including quoteToken)
address constant MAGIC_DIVIDEND_SELF = address(0xfEEDFEEDfeEDFEedFEEdFEEDFeEdfEEdFeEdFEEd);

/// @dev Magic address value for `dividendToken` in NewTokenV6Params / FeeConfig.
///      When set to this address, VaultPortal asks the selected vault factory to compute the
///      actual dividend token from the CREATE2-predicted tax-token address before forwarding the
///      launch into Portal. Requires a v2.3+ vault factory.
///      Uses a dedicated sentinel (0xC0DE...C0DE) that does not collide with real ERC-20s,
///      address(0), or MAGIC_DIVIDEND_SELF.
address constant MAGIC_DIVIDEND_COMPUTED = address(0xC0Dec0dec0DeC0Dec0dEc0DEC0DEC0DEC0DEC0dE);

/// @title Common Types
/// @notice This interface defines common types shared across the portal
interface IPortalCommonTypes {
    /// @dev curve Types
    enum CurveType {
        CURVE_LEGACY_15, // r = 15
        CURVE_4, // r = 4
        CURVE_0_974, // r = 0.974
        CURVE_0_5, // r = 0.5
        CURVE_1000, // r = 1000
        CURVE_20000, // r = 20000
        CURVE_2500, // r = 2500
        CURVE_500, // r = 500
        CURVE_2, // r = 2
        CURVE_6, // r = 6
        CURVE_75, // r = 75
        CURVE_4M, // r= 4 M
        CURVE_28, // r = 28
        CURVE_21_25, // r = 21.25
        CURVE_RH_UNUSED, // r = 27.6, h = 352755468
        CURVE_RH_28D25_108002126, // r = 28.25, h = 108002126, k = 31301060059.5
        CURVE_RH_14981_108002125, // r = 14981, h = 108002125, k = 16598979834625
        CURVE_RH_TOSHI_MORPH_2ETH, // r = 0.7672, h = 107036751, k = 849318595.3672 - TOSHI/MORPH 2ETH curve
        CURVE_RH_TOSHI, // r = 6140351, h = 107036752, k = 6797594227179952 - TOSHI Curve
        CURVE_RH_BGB, // r = 767.5, h = 107036752, k = 849650707160 - BGB curve
        CURVE_RH_BNB, // r = 6.14, h = 107036752, k = 6797205657.28 - BNB Curve
        CURVE_RH_USD, // r = 3837, h = 107036752, k = 4247700017424 - USD curve
        CURVE_RH_MONAD, // r = 50000, h = 107036752, k = 55351837600000 - MONAD curve
        CURVE_RH_MONAD_V2, // r = 107400, h = 107036752, k = 118895747164800  - MONAD V2 curve
        CURVE_RH_KGST // r = 380000, h = 107036752, k = 420673965760000 - KGST curve
    }

    /// @dev dex threshold types
    enum DexThreshType {
        TWO_THIRDS, //  66.67% supply
        FOUR_FIFTHS, // 80% supply
        HALF, // 50% supply
        _95_PERCENT, // 95% supply
        _81_PERCENT, // 81% supply
        _1_PERCENT // 1% supply => mainly for testing
    }

    /// @notice Fee profile for tokens
    /// @dev Determines the fee structure applied to a token's trades and liquidity operations
    /// Fees are represented in basis points (bps), where 1% = 100 bps
    enum FlapFeeProfile {
        FEE_GLOBAL_DEFAULT, // Default fee profile used when no specific profile is set for a token
        FEE_FLAPSALE_V0 // Fee profile for FlapSale V0
    }

    //
    // Custom Errors for Common Types
    //

    /// @notice error if the curve type is invalid
    /// @param curveType The invalid curve type
    error InvalidCurveType(CurveType curveType);

    /// @notice error if the dex threshold type is invalid
    error InvalidDexThresholdType(DexThreshType threshold);
}

/// @title Types and Structs
/// @notice This interface defines the types and structs used in the portal
interface IPortalTypes is IPortalCommonTypes {
    //
    // public constants
    //

    //
    // Types and Structs
    //

    /// @dev Profile types for deployment-specific parameters or behaviors
    enum Profile {
        DEFAULT,
        TOSHI_MART,
        X_LAYER,
        MORPH,
        MONAD
    }

    /// @dev Token version
    /// Which token implementation is used
    enum TokenVersion {
        TOKEN_LEGACY_MINT_NO_PERMIT,
        TOKEN_LEGACY_MINT_NO_PERMIT_DUPLICATE, // for historical reasons, both 0 and 1 are the same: TOKEN_LEGACY_MINT_NO_PERMIT
        TOKEN_V2_PERMIT, // 2
        TOKEN_GOPLUS, // 3
        TOKEN_TAXED, // 4: The original tax token (FlapTaxToken)
        TOKEN_TAXED_V2, // 5: The new advanced tax token (FlapTaxTokenV2)
        TOKEN_TAXED_V3, // 6: The next-generation tax token with asymmetric buy/sell rates (FlapTaxTokenV3)
        TOKEN_V3_PERMIT // 7: Non-tax token using TokenV3 implementation with permit support
    }

    /// @dev the quote token, i.e, the token as the reserve
    enum QuoteTokenType {
        NATIVE_GAS_TOKEN, // The native gas token
        ERC20_TOKEN_WITH_PERMIT, //  The ERC20 token with permit
        ERC20_TOKEN_WITHOUT_PERMIT // The ERC20 token without permit
    }

    /// @notice the status of a token
    /// The token has 5 statuses:
    //    - Tradable: The token can be traded(buy/sell)
    //    - InDuel: (obsolete) The token is in a battle, it can only be bought but not sold.
    //    - Killed: (obsolete) The token is killed, it can not be traded anymore. Can only be redeemed for another token.
    //    - DEX: The token has been added to the DEX
    //    - Staged: The token is staged but not yet created (address is predetermined)
    enum TokenStatus {
        Invalid, // The token does not exist
        Tradable,
        InDuel, // obsolete
        Killed, // obsolete
        DEX,
        Staged // The token is staged (address determined, but not yet created)
    }

    /// @notice the migrator type
    /// @dev the migrator type determines how the liquidity is added to the DEX.
    /// Note: To mitigate the risk of DOS, if a V3 migrator is used but the liquidity cannot
    /// be added to v3 pools, the migrator will fallback to a V2 migrator.
    /// A TAX token must use a V2 migrator.
    enum MigratorType {
        V3_MIGRATOR, // Migrate the liquidity to a Uniswap V3 like pool
        V2_MIGRATOR, // Migrate the liquidity to a Uniswap V2 like pool
        V4_UNI_MIGRATOR, // Migrate the liquidity to a Uniswap V4 pool (Base, XLayer)
        PCS_INFINITY_CL_MIGRATOR // Migrate the liquidity to a Pancake Infinity CL Pool (BNB)
    }

    /// @notice the V3 LP fee profile
    /// @dev determines the LP fee tier to use when migrating tokens to Uniswap V3 or Pancake V3
    enum V3LPFeeProfile {
        LP_FEE_PROFILE_STANDARD, // Standard fee tier:  0.25% on PancakeSwap, 0.3% on Uniswap
        LP_FEE_PROFILE_LOW, // Low fee tier: typically, 0.01% on PancakeSwap, 0.05% on Uniswap
        LP_FEE_PROFILE_HIGH // High fee tier (1% for exotic pairs)
    }

    /// @notice the DEX ID
    /// @dev determines the DEX we want to migrate to
    /// On BSC:
    ///   - only DEX0 will be enabled, which is PancakeSwap
    /// On xLayer:
    ///   - only DEX0 will be enabled, which is PotatoSwap
    /// On Monad:
    ///   - DEX0 is Uniswap
    ///   - DEX1 is PancakeSwap
    ///   - DEX2 is Monday
    /// Note that, currently, we only support at most 3 DEXes
    /// We may add more DEXes in the future if needed
    enum DEXId {
        DEX0,
        DEX1,
        DEX2
    }

    /// @notice the state of a token (with dex related fields)
    struct TokenStateV2 {
        TokenStatus status; // the status of the token
        uint256 reserve; // the reserve of the token
        uint256 circulatingSupply; // the circulatingSupply of the token
        uint256 price; // the price of the token
        TokenVersion tokenVersion; // the version of the token implementation this token is using
        uint256 r; // the r of the curve of the token
        uint256 dexSupplyThresh; // the cirtulating supply threshold for adding the token to the DEX
    }

    /// @notice the state of a token (with all V2 fields plus quoteTokenAddress and nativeToQuoteSwapEnabled)
    struct TokenStateV3 {
        /// The status of the token (see TokenStatus enum)
        TokenStatus status;
        /// The reserve amount of the quote token held by the bonding curve
        uint256 reserve;
        /// The circulating supply of the token
        uint256 circulatingSupply;
        /// The current price of the token (in quote token units, 18 decimals)
        uint256 price;
        /// The version of the token implementation (see TokenVersion enum)
        TokenVersion tokenVersion;
        /// The curve parameter 'r' used for the bonding curve
        uint256 r;
        /// The circulating supply threshold for adding the token to the DEX
        uint256 dexSupplyThresh;
        /// The address of the quote token (address(0) if native gas token)
        address quoteTokenAddress;
        /// Whether native-to-quote swap is enabled for this token
        bool nativeToQuoteSwapEnabled;
    }

    /// @notice the state of a token (with all V3 fields plus extensionID and 'r' curve parameter only)
    struct TokenStateV4 {
        /// The status of the token (see TokenStatus enum)
        TokenStatus status;
        /// The reserve amount of the quote token held by the bonding curve
        uint256 reserve;
        /// The circulating supply of the token
        uint256 circulatingSupply;
        /// The current price of the token (in quote token units, 18 decimals)
        uint256 price;
        /// The version of the token implementation (see TokenVersion enum)
        TokenVersion tokenVersion;
        /// The curve parameter 'r' used for the bonding curve
        uint256 r;
        /// The circulating supply threshold for adding the token to the DEX
        uint256 dexSupplyThresh;
        /// The address of the quote token (address(0) if native gas token)
        address quoteTokenAddress;
        /// Whether native-to-quote swap is enabled for this token
        bool nativeToQuoteSwapEnabled;
        /// The extension ID used by the token (bytes32(0) if no extension)
        bytes32 extensionID;
    }

    /// @notice the state of a token (with all V4 fields plus all curve parameters)
    struct TokenStateV5 {
        /// The status of the token (see TokenStatus enum)
        TokenStatus status;
        /// The reserve amount of the quote token held by the bonding curve
        uint256 reserve;
        /// The circulating supply of the token
        uint256 circulatingSupply;
        /// The current price of the token (in quote token units, 18 decimals)
        uint256 price;
        /// The version of the token implementation (see TokenVersion enum)
        TokenVersion tokenVersion;
        /// The curve parameter 'r' used for the bonding curve
        uint256 r;
        /// The curve parameter 'h' - virtual token reserve
        uint256 h;
        /// The curve parameter 'k' - square of virtual liquidity
        uint256 k;
        /// The circulating supply threshold for adding the token to the DEX
        uint256 dexSupplyThresh;
        /// The address of the quote token (address(0) if native gas token)
        address quoteTokenAddress;
        /// Whether native-to-quote swap is enabled for this token
        bool nativeToQuoteSwapEnabled;
        /// The extension ID used by the token (bytes32(0) if no extension)
        bytes32 extensionID;
    }

    /// @notice the state of a token (with all V5 fields plus taxRate, pool, and progress)
    struct TokenStateV6 {
        /// The status of the token (see TokenStatus enum)
        TokenStatus status;
        /// The reserve amount of the quote token held by the bonding curve
        uint256 reserve;
        /// The circulating supply of the token
        uint256 circulatingSupply;
        /// The current price of the token (in quote token units, 18 decimals)
        uint256 price;
        /// The version of the token implementation (see TokenVersion enum)
        TokenVersion tokenVersion;
        /// The curve parameter 'r' used for the bonding curve
        uint256 r;
        /// The curve parameter 'h' - virtual token reserve
        uint256 h;
        /// The curve parameter 'k' - square of virtual liquidity
        uint256 k;
        /// The circulating supply threshold for adding the token to the DEX
        uint256 dexSupplyThresh;
        /// The address of the quote token (address(0) if native gas token)
        address quoteTokenAddress;
        /// Whether native-to-quote swap is enabled for this token
        bool nativeToQuoteSwapEnabled;
        /// The extension ID used by the token (bytes32(0) if no extension)
        bytes32 extensionID;
        /// The tax rate in basis points (0 if not a tax token)
        uint256 taxRate;
        /// The DEX pool address (address(0) if not listed on DEX)
        address pool;
        /// The progress towards DEX listing (0 to 1e18, where 1e18 = 100%)
        uint256 progress;
    }

    /// @notice the state of a token (with all V6 fields plus lpFeeProfile)
    struct TokenStateV7 {
        /// The status of the token (see TokenStatus enum)
        TokenStatus status;
        /// The reserve amount of the quote token held by the bonding curve
        uint256 reserve;
        /// The circulating supply of the token
        uint256 circulatingSupply;
        /// The current price of the token (in quote token units, 18 decimals)
        uint256 price;
        /// The version of the token implementation (see TokenVersion enum)
        TokenVersion tokenVersion;
        /// The curve parameter 'r' used for the bonding curve
        uint256 r;
        /// The curve parameter 'h' - virtual token reserve
        uint256 h;
        /// The curve parameter 'k' - square of virtual liquidity
        uint256 k;
        /// The circulating supply threshold for adding the token to the DEX
        uint256 dexSupplyThresh;
        /// The address of the quote token (address(0) if native gas token)
        address quoteTokenAddress;
        /// Whether native-to-quote swap is enabled for this token
        bool nativeToQuoteSwapEnabled;
        /// The extension ID used by the token (bytes32(0) if no extension)
        bytes32 extensionID;
        /// The tax rate in basis points (0 if not a tax token)
        uint256 taxRate;
        /// The DEX pool address (address(0) if not listed on DEX)
        address pool;
        /// The progress towards DEX listing (0 to 1e18, where 1e18 = 100%)
        uint256 progress;
        /// The V3 LP fee profile for the token
        V3LPFeeProfile lpFeeProfile;
        /// The Dex Id
        DEXId dexId;
    }

    struct TokenStateV8 {
        /// The status of the token (see TokenStatus enum)
        TokenStatus status;
        /// The reserve amount of the quote token held by the bonding curve
        uint256 reserve;
        /// The circulating supply of the token
        uint256 circulatingSupply;
        /// The current price of the token (in quote token units, 18 decimals)
        uint256 price;
        /// The version of the token implementation (see TokenVersion enum)
        TokenVersion tokenVersion;
        /// The curve parameter 'r' used for the bonding curve
        uint256 r;
        /// The curve parameter 'h' - virtual token reserve
        uint256 h;
        /// The curve parameter 'k' - square of virtual liquidity
        uint256 k;
        /// The circulating supply threshold for adding the token to the DEX
        uint256 dexSupplyThresh;
        /// The address of the quote token (address(0) if native gas token)
        address quoteTokenAddress;
        /// Whether native-to-quote swap is enabled for this token
        bool nativeToQuoteSwapEnabled;
        /// The extension ID used by the token (bytes32(0) if no extension)
        bytes32 extensionID;
        /// The buy tax rate in basis points (0 if not a tax token)
        uint256 buyTaxRate;
        /// The sell tax rate in basis points (0 if not a tax token)
        uint256 sellTaxRate;
        /// The DEX pool address (address(0) if not listed on DEX)
        address pool;
        /// The progress towards DEX listing (0 to 1e18, where 1e18 = 100%)
        uint256 progress;
        /// The V3 LP fee profile for the token
        V3LPFeeProfile lpFeeProfile;
        /// The Dex Id
        DEXId dexId;
    }

    /// @notice A forward-compatible version of TokenStateV8, where enum-typed fields are returned
    ///         as uint8 instead of their Solidity enum types.
    /// @dev Safe because Solidity revert when decoding an enum value that exceeds the enum's
    ///      declared maximum (e.g. a new TOKEN_TAXED_V3 value read by a contract compiled against
    ///      an old TokenVersion enum). By using uint8 for TokenStatus, TokenVersion,
    ///      V3LPFeeProfile, and DEXId, callers are not affected when new variants are added to
    ///      any of those enums in the future. Use getTokenV8 if you are always up-to-date with
    ///      the latest interface; use this method if you need forward/backward compatibility.
    struct TokenStateV8Safe {
        /// The status of the token (see TokenStatus enum for interpretation)
        uint8 status;
        /// The reserve amount of the quote token held by the bonding curve
        uint256 reserve;
        /// The circulating supply of the token
        uint256 circulatingSupply;
        /// The current price of the token (in quote token units, 18 decimals)
        uint256 price;
        /// The version of the token implementation (see TokenVersion enum for interpretation)
        uint8 tokenVersion;
        /// The curve parameter 'r' used for the bonding curve
        uint256 r;
        /// The curve parameter 'h' - virtual token reserve
        uint256 h;
        /// The curve parameter 'k' - square of virtual liquidity
        uint256 k;
        /// The circulating supply threshold for adding the token to the DEX
        uint256 dexSupplyThresh;
        /// The address of the quote token (address(0) if native gas token)
        address quoteTokenAddress;
        /// Whether native-to-quote swap is enabled for this token
        bool nativeToQuoteSwapEnabled;
        /// The extension ID used by the token (bytes32(0) if no extension)
        bytes32 extensionID;
        /// The buy tax rate in basis points (0 if not a tax token)
        uint256 buyTaxRate;
        /// The sell tax rate in basis points (0 if not a tax token)
        uint256 sellTaxRate;
        /// The DEX pool address (address(0) if not listed on DEX)
        address pool;
        /// The progress towards DEX listing (0 to 1e18, where 1e18 = 100%)
        uint256 progress;
        /// The V3 LP fee profile for the token (see V3LPFeeProfile enum for interpretation)
        uint8 lpFeeProfile;
        /// The Dex Id (see DEXId enum for interpretation)
        uint8 dexId;
    }

    /// @notice Parameters for creating a new token (V2)
    struct NewTokenV2Params {
        /// The name of the token
        string name;
        /// The symbol of the token
        string symbol;
        /// The metadata URI of the token
        string meta;
        /// The DEX supply threshold type
        DexThreshType dexThresh;
        /// The salt for deterministic deployment
        bytes32 salt;
        /// The tax rate in basis points (if non-zero, this is a tax token)
        uint16 taxRate;
        /// The migrator type (see MigratorType enum)
        MigratorType migratorType;
        /// The quote token address (native gas token if zero address)
        address quoteToken;
        /// The initial quote token amount to spend for buying
        uint256 quoteAmt;
        /// The beneficiary address for the token
        /// For rev share tokens, this is the address that can claim the LP fees
        /// For tax tokens, this is the address that receives the tax fees
        address beneficiary;
        /// The optional permit data for the quote token
        bytes permitData;
    }

    /// @notice Parameters for creating a new token (V3) with extension support
    struct NewTokenV3Params {
        /// The name of the token
        string name;
        /// The symbol of the token
        string symbol;
        /// The metadata URI of the token
        string meta;
        /// The DEX supply threshold type
        DexThreshType dexThresh;
        /// The salt for deterministic deployment
        bytes32 salt;
        /// The tax rate in basis points (if non-zero, this is a tax token)
        uint16 taxRate;
        /// The migrator type (see MigratorType enum)
        MigratorType migratorType;
        /// The quote token address (native gas token if zero address)
        address quoteToken;
        /// The initial quote token amount to spend for buying
        uint256 quoteAmt;
        /// The beneficiary address for the token
        /// For rev share tokens, this is the address that can claim the LP fees
        /// For tax tokens, this is the address that receives the tax fees
        address beneficiary;
        /// The optional permit data for the quote token
        bytes permitData;
        /// @notice The ID of the extension to be used for the new token if not zero
        bytes32 extensionID;
        /// @notice Additional extension specific data to be passed to the extension's `onTokenCreation` method, check the extension's documentation for details on the expected format and content.
        bytes extensionData;
    }

    /// @notice Parameters for creating a new token (V4) with DEX ID and LP fee profile support
    struct NewTokenV4Params {
        /// The name of the token
        string name;
        /// The symbol of the token
        string symbol;
        /// The metadata URI of the token
        string meta;
        /// The DEX supply threshold type
        DexThreshType dexThresh;
        /// The salt for deterministic deployment
        bytes32 salt;
        /// The tax rate in basis points (if non-zero, this is a tax token)
        uint16 taxRate;
        /// The migrator type (see MigratorType enum)
        MigratorType migratorType;
        /// The quote token address (native gas token if zero address)
        address quoteToken;
        /// The initial quote token amount to spend for buying
        uint256 quoteAmt;
        /// The beneficiary address for the token
        /// For rev share tokens, this is the address that can claim the LP fees
        /// For tax tokens, this is the address that receives the tax fees
        address beneficiary;
        /// The optional permit data for the quote token
        bytes permitData;
        /// @notice The ID of the extension to be used for the new token if not zero
        bytes32 extensionID;
        /// @notice Additional extension specific data to be passed to the extension's `onTokenCreation` method, check the extension's documentation for details on the expected format and content.
        bytes extensionData;
        /// @notice The preferred DEX ID for the token
        DEXId dexId;
        /// @notice The preferred V3 LP fee profile for the token
        V3LPFeeProfile lpFeeProfile;
    }

    /// @notice Parameters for creating a new token (V5) with tax V2 support
    struct NewTokenV5Params {
        /// The name of the token
        string name;
        /// The symbol of the token
        string symbol;
        /// The metadata URI of the token
        string meta;
        /// The DEX supply threshold type
        DexThreshType dexThresh;
        /// The salt for deterministic deployment
        bytes32 salt;
        /// The tax rate in basis points (if non-zero, this is a tax token)
        uint16 taxRate;
        /// The migrator type (see MigratorType enum)
        MigratorType migratorType;
        /// The quote token address (native gas token if zero address)
        address quoteToken;
        /// The initial quote token amount to spend for buying
        uint256 quoteAmt;
        /// The beneficiary address for the token
        /// For rev share tokens, this is the address that can claim the LP fees
        /// For tax tokens, this is the address that receives the tax fees
        address beneficiary;
        /// The optional permit data for the quote token
        bytes permitData;
        /// @notice The ID of the extension to be used for the new token if not zero
        bytes32 extensionID;
        /// @notice Additional extension specific data to be passed to the extension's `onTokenCreation` method, check the extension's documentation for details on the expected format and content.
        bytes extensionData;
        /// @notice The preferred DEX ID for the token
        DEXId dexId;
        /// @notice The preferred V3 LP fee profile for the token
        V3LPFeeProfile lpFeeProfile;
        // New V5 tax-specific fields (only used when taxRate > 0)
        /// Tax duration in seconds (max: 100 years)
        uint64 taxDuration;
        /// Anti-farmer duration in seconds (max: 1 year)
        uint64 antiFarmerDuration;
        /// Market allocation basis points (to beneficiary)
        uint16 mktBps;
        /// Deflation basis points (burned)
        uint16 deflationBps;
        /// Dividend basis points (to dividend contract)
        uint16 dividendBps;
        /// Liquidity provision basis points (LP to dead address)
        uint16 lpBps;
        /// Minimum balance for dividend eligibility (min: 10K ether, required when dividendBps > 0)
        uint256 minimumShareBalance;
    }

    /// @dev Magic address value for `dividendToken` in NewTokenV6Params.
    ///      When set to MAGIC_DIVIDEND_SELF, the dividend token is resolved to the tax token's own address
    ///      after it is created. See MAGIC_DIVIDEND_SELF file-level constant.

    /// @notice Parameters for creating a new token (V6) with asymmetric tax and custom dividend token
    struct NewTokenV6Params {
        // --- Same base fields as V5 ---
        /// The name of the token
        string name;
        /// The symbol of the token
        string symbol;
        /// The metadata URI of the token
        string meta;
        /// The DEX supply threshold type
        DexThreshType dexThresh;
        /// The salt for deterministic deployment
        bytes32 salt;
        /// The migrator type (see MigratorType enum)
        MigratorType migratorType;
        /// The quote token address (native gas token if zero address)
        address quoteToken;
        /// The initial quote token amount to spend for buying
        uint256 quoteAmt;
        /// The beneficiary address for the token
        address beneficiary;
        /// The optional permit data for the quote token
        bytes permitData;
        /// The ID of the extension to be used for the new token if not zero
        bytes32 extensionID;
        /// Additional extension specific data
        bytes extensionData;
        /// The preferred DEX ID for the token
        DEXId dexId;
        /// The preferred V3 LP fee profile for the token
        V3LPFeeProfile lpFeeProfile;
        // --- Tax fields (all zero = non-tax token, behaves like newTokenV5) ---
        /// Buy tax rate in basis points (0 = no buy tax)
        uint16 buyTaxRate;
        /// Sell tax rate in basis points (0 = no sell tax)
        uint16 sellTaxRate;
        /// Tax duration in seconds
        uint64 taxDuration;
        /// Anti-farmer duration in seconds
        uint64 antiFarmerDuration;
        /// Market allocation basis points (to beneficiary)
        uint16 mktBps;
        /// Deflation basis points (burned)
        uint16 deflationBps;
        /// Dividend basis points (to dividend contract)
        uint16 dividendBps;
        /// Liquidity provision basis points (LP to dead address)
        uint16 lpBps;
        /// Minimum balance for dividend eligibility (required when dividendBps > 0)
        uint256 minimumShareBalance;
        // --- New V3-only fields ---
        /// @notice Dividend distribution token:
        ///   address(0)         = native gas token dividend (only valid when quoteToken is also address(0))
        ///   MAGIC_DIVIDEND_SELF = distribute the tax token itself as dividend
        ///   MAGIC_DIVIDEND_COMPUTED = let VaultPortal ask a v2.3+ vault factory to compute the
        ///                             dividend token from the predicted tax-token address
        ///   quoteToken address  = explicitly use the quote token as dividend (must be set explicitly)
        ///   any other ERC-20   = use that specific ERC-20 as dividend token
        address dividendToken;
        /// @notice Commission receiver address (zero = disabled).
        ///         MUST be address(0) for non-tax tokens (buyTaxRate == 0 && sellTaxRate == 0).
        ///         commissionBps is NOT provided here — it is calculated internally by the launcher
        ///         based on the effective tax rate via _commissionForTax().
        address commissionReceiver;
        /// @notice The token version to create. Determines which launcher path is used.
        ///   TOKEN_V2_PERMIT  — non-tax token (standard ERC-20 with permit)
        ///   TOKEN_TAXED      — V1 tax token (symmetric rates, mktBps=10000, no commission)
        ///   TOKEN_TAXED_V2   — V2 tax token (asymmetric rates, flexible distribution, no commission, mktBps != 10000)
        ///   TOKEN_TAXED_V3   — V3 tax token (asymmetric rates, flexible distribution, commission supported)
        TokenVersion tokenVersion;
    }
    // NOTE: `converter` is NOT in this struct — it is provided as an immutable
    // in PortalBase and automatically passed to TaxProcessor at initialization.

    // ─── V7 Fee Configuration ────────────────────────────────────────────────

    enum FeeType {
        NONE,
        MARKETING_OR_VAULT,
        DIVIDEND,
        DEFLATION,
        LP_BPS
    }

    struct FeeConfig {
        FeeType feeType;
        uint16 bps;
        address marketingAddress;
        address dividendToken;
        uint256 minimumShareBalance;
    }

    struct NewTokenV7Params {
        string name;
        string symbol;
        string meta;
        DexThreshType dexThresh;
        bytes32 salt;
        MigratorType migratorType;
        address quoteToken;
        uint256 quoteAmt;
        bytes permitData;
        bytes32 extensionID;
        bytes extensionData;
        DEXId dexId;
        uint16 buyTaxRate;
        uint16 sellTaxRate;
        uint64 taxDuration;
        uint64 antiFarmerDuration;
        address commissionReceiver;
        TokenVersion tokenVersion;
        FeeConfig[4] feeConfigs;
    }

    /// @notice Parameters for staging a new token (V5) - immutable parameters only
    struct StageNewTokenV5Params {
        /// The DEX supply threshold type
        DexThreshType dexThresh;
        /// The salt for deterministic deployment
        bytes32 salt;
        /// Whether this is a tax token
        bool isTaxToken;
        /// The migrator type (see MigratorType enum)
        MigratorType migratorType;
        /// The quote token address (native gas token if zero address)
        address quoteToken;
        /// @notice The preferred DEX ID for the token
        DEXId dexId;
    }

    /// @notice Parameters for committing a staged token (V5) - mutable/deployment-time parameters
    struct CommitNewTokenV5Params {
        /// The salt for deterministic deployment (must match staged salt)
        bytes32 salt;
        /// The tax rate in basis points (0 for non-tax tokens)
        uint16 taxRate;
        /// The name of the token
        string name;
        /// The symbol of the token
        string symbol;
        /// The metadata URI of the token
        string meta;
        /// The initial quote token amount to spend for buying
        uint256 quoteAmt;
        /// The beneficiary address for the token
        /// For rev share tokens, this is the address that can claim the LP fees
        /// For tax tokens, this is the address that receives the tax fees
        address beneficiary;
        /// The optional permit data for the quote token
        bytes permitData;
        // New V5 tax-specific fields (only used when taxRate > 0)
        /// Tax duration in seconds (max: 100 years)
        uint64 taxDuration;
        /// Anti-farmer duration in seconds (max: 1 year)
        uint64 antiFarmerDuration;
        /// Market allocation basis points (to beneficiary)
        uint16 mktBps;
        /// Deflation basis points (burned)
        uint16 deflationBps;
        /// Dividend basis points (to dividend contract)
        uint16 dividendBps;
        /// Liquidity provision basis points (LP to dead address)
        uint16 lpBps;
        /// Minimum balance for dividend eligibility (required when dividendBps > 0)
        uint256 minimumShareBalance;
    }

    /// @dev The configuration of the "native to quote" swap
    /// i.e How to swap ETH for the quote token when the quote token is not ETH
    enum NativeToQuoteSwapType {
        SWAP_DISABLED, // 0: disabled
        SWAP_VIA_V2_POOL, // 1: swap through v2 pool
        SWAP_VIA_V3_2500_POOL, // 2: swap through v3 2500 pool
        SWAP_VIA_V3_500_POOL, // 3: swap through v3 500 pool
        SWAP_VIA_V3_3000_POOL, // 4: swap through v3 3000 pool
        SWAP_VIA_V3_10000_POOL, // 5: swap through v3 10000 pool
        SWAP_VIA_MIXED_ROUTER // 6: multi-hop via PancakeSwap Infinity MixedQuoter + UniversalRouter (BSC only)
        //    used for tokens like uUSD that route BNB ↔ USDT(V3) ↔ uUSD(BinPool).
        //    The actual routing logic is bypassed in _shouldUseMixedRouter() before
        //    the enum is checked, so this value serves as a meaningful marker when
        //    calling setQuoteTokenConfiguration — any non-SWAP_DISABLED value would
        //    work, but this makes intent explicit.
    }

    /// @dev  the quote token configurations
    struct QuoteTokenConfiguration {
        uint8 enabled; // 8bit: 1 if allowed, 0 if not allowed
        CurveType defaultCurve; // 8bit: the default token curve type of the quote token
        CurveType alternativeCurve; // 8bit: the alternative token curve type of the quote token
        NativeToQuoteSwapType nativeToQuoteSwapType; // 8bit: the native to quote swap feature configuration of the quote token
        uint8 dexId; // 8bit: DEX ID for multiple DEXes support
    }

    /// @dev Enum for DEX pool types
    enum PoolType {
        V2, // Uniswap V2 style pools
        V3 // Uniswap V3 style pools
    }

    /// @dev Packed DEX pool information
    struct PackedDexPool {
        address pool; // 160 bits: pool address
        uint24 fee; // 24 bits: fee tier (for V3), 0 for V2
        PoolType poolType; // 8 bits: enum for pool type
        uint64 unused; // 64 bits: reserved for future use
    }

    /// @notice Records who locked a CREATE2 salt and for which token version.
    ///         locker + tokenVersion pack into a single 32-byte storage slot.
    struct SaltLockEntry {
        address locker; // 20 bytes — address that paid to reserve this salt
        uint8 tokenVersion; // 1 byte  — TokenVersion enum value at lock time
    }

    //
    // Events
    //

    /// @notice emitted when a token is staged (but not yet created)
    ///
    /// @param ts The timestamp of the event
    /// @param creator The address of the creator
    /// @param token The predetermined address of the token
    event FlapTokenStaged(uint256 ts, address creator, address token);

    /// @notice emitted when a new token is created
    ///
    /// @param ts The timestamp of the event
    /// @param creator The address of the creator
    /// @param nonce The nonce of the token
    /// @param token  The address of the token
    /// @param name  The name of the token
    /// @param symbol  The symbol of the token
    /// @param meta The meta URI of the token
    event TokenCreated(
        uint256 ts, address creator, uint256 nonce, address token, string name, string symbol, string meta
    );

    /// @notice emitted when a token is bought
    ///
    /// @param ts The timestamp of the event
    /// @param token  The address of the token
    /// @param buyer  The address of the buyer
    /// @param amount  The amount of tokens bought
    /// @param eth  The amount of ETH spent
    /// @param fee The amount of ETH spent on fee
    /// @param postPrice The price of the token after this trade
    event TokenBought(
        uint256 ts, address token, address buyer, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice
    );

    /// @notice emitted when a token is sold
    ///
    /// @param ts The timestamp of the event
    /// @param token  The address of the token
    /// @param seller  The address of the seller
    /// @param amount  The amount of tokens sold
    /// @param eth  The amount of ETH received
    /// @param fee  The amount of ETH deducted as a fee
    /// @param postPrice The price of the token after this trade
    event TokenSold(
        uint256 ts, address token, address seller, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice
    );

    /// emitted when a token's curve is set
    /// @param token The address of the token
    /// @param curve The address of the curve
    /// @param curveParameter The parameter of the curve
    event TokenCurveSet(address token, address curve, uint256 curveParameter);

    /// @notice emitted when a token's curve parameters are set (V2)
    /// @param token The address of the token
    /// @param r The virtual ETH reserve parameter
    /// @param h The virtual token reserve parameter
    /// @param k The square of the virtual Liquidity parameter
    event TokenCurveSetV2(address token, uint256 r, uint256 h, uint256 k);

    /// emitted when a token's dexSupplyThresh is set
    /// @param token The address of the token
    /// @param dexSupplyThresh The new dexSupplyThresh of the token
    event TokenDexSupplyThreshSet(address token, uint256 dexSupplyThresh);

    /// emitted when a token's implementation is set
    /// @param token The address of the token
    /// @param version The version of the token
    event TokenVersionSet(address token, TokenVersion version);

    /// @notice emitted when a new vanity token is created
    /// @param token The address of the created token
    /// @param creator The address of the creator
    /// @param beneficiary The address of the beneficiary
    event VanityTokenCreated(address token, address creator, address beneficiary);

    /// @notice emitted when a token's quote token is set
    /// @param token The address of the token
    /// @param quoteToken The address of the quote token
    event TokenQuoteSet(address token, address quoteToken);

    /// @notice emitted when a token's migrator is set
    /// @param token The address of the token
    /// @param migratorType The migrator type
    event TokenMigratorSet(address token, MigratorType migratorType);

    /// @notice emitted when a token's extension is enabled
    /// @param token The address of the token
    /// @param extensionID The extension ID
    /// @param extensionAddress The address of the extension contract
    /// @param version The version of the extension
    event TokenExtensionEnabled(address token, bytes32 extensionID, address extensionAddress, uint8 version);

    /// @notice emitted when a token's pool info is updated
    /// @param token The address of the token
    /// @param poolInfo The new pool information
    event TokenPoolInfoUpdated(address token, PackedDexPool poolInfo);

    /// @notice emitted when a trader's fee exemption status is updated
    /// @param trader The address of the trader
    /// @param isExempted Whether the trader is exempted from fees
    event FeeExemptionUpdated(address indexed trader, bool isExempted);

    //
    // events
    //

    /// @notice emitted when token is redeemed
    /// @param ts The timestamp of the event
    /// @param srcToken The address of the token to redeem
    /// @param dstToken The address of the token to receive
    /// @param srcAmount The amount of srcToken to redeem
    /// @param dstAmount The amount of dstToken to receive
    /// @param who The address of the redeemer
    event TokenRedeemed(
        uint256 ts, address srcToken, address dstToken, uint256 srcAmount, uint256 dstAmount, address who
    );

    /// @notice emitted when the bit flags are changed
    /// @param oldFlags The old flags
    /// @param newFlags The new flags
    event BitFlagsChanged(uint256 oldFlags, uint256 newFlags);

    /// @notice emitted when adding liquidity to DEX
    /// @param token The address of the token
    /// @param pool The address of the pool
    /// @param amount The amount of token added
    /// @param eth The amount of quote Token added
    event LaunchedToDEX(address token, address pool, uint256 amount, uint256 eth);

    /// @notice emitted when the progress of a token changes
    /// @param token The address of the token
    /// @param newProgress The new progress value in Wad
    event FlapTokenProgressChanged(address token, uint256 newProgress);

    //
    // Token V2 supply change
    //

    /// @notice emitted when the circulating supply of a token changes
    /// @param token The address of the token
    /// @param newSupply The new circulating supply
    event FlapTokenCirculatingSupplyChanged(address token, uint256 newSupply);

    /// @notice emitted when a new tax is set for a token
    /// @dev For V3 tokens with asymmetric rates, this carries max(buyTax, sellTax) for backward compatibility.
    ///      Listen for FlapTokenAsymmetricTaxSet to get the full buy/sell split.
    /// @param token The address of the token
    /// @param tax The tax value set for the token (max of buy and sell rates for V3 tokens)
    event FlapTokenTaxSet(address token, uint256 tax);

    /// @notice Emitted when a token is launched with asymmetric buy/sell tax rates (V3 tokens only).
    /// @dev Emitted in addition to FlapTokenTaxSet (which carries max(buyTax, sellTax) for backward
    ///      compatibility). New systems that support asymmetric rates should listen to this event.
    ///      Old systems that only read FlapTokenTaxSet will continue to work correctly.
    /// @param token The address of the token
    /// @param buyTax The buy tax rate in basis points
    /// @param sellTax The sell tax rate in basis points
    event FlapTokenAsymmetricTaxSet(address token, uint256 buyTax, uint256 sellTax);

    // operation related
    // should remove later

    /// @notice emitted when a users successfully checked in
    /// @param user The address of the user
    event CheckedIn(address user);

    /// @notice emitted when a beneficiary claims fees
    /// @param token The address of the token
    /// @param beneficiary The address of the beneficiary
    /// @param tokenAmount The amount of the token claimed
    /// @param ethAmount The amount of ETH claimed
    event BeneficiaryClaimed(address token, address beneficiary, uint256 tokenAmount, uint256 ethAmount);

    /// @notice emitted when a token beneficiary is changed
    /// @param token The address of the token
    /// @param oldBeneficiary The previous beneficiary address
    /// @param newBeneficiary The new beneficiary address
    event BeneficiaryChanged(address token, address oldBeneficiary, address newBeneficiary);

    /// @notice emitted when an extension is registered
    /// @param extensionId The unique identifier for the extension
    /// @param extensionAddress The address of the extension contract
    /// @param version The version of the extension
    event ExtensionRegistered(bytes32 extensionId, address extensionAddress, uint8 version);

    /// @notice emitted when a spammer's blocked status is changed
    /// @param spammer The address of the spammer
    /// @param blocked True if blocked, false if unblocked
    event SpammerBlockedStatusChanged(address spammer, bool blocked);

    /// @notice emitted when a user is rate limited from creating tokens
    /// @param user The address of the rate-limited user
    /// @param lastCreationTime The timestamp of their last successful token creation
    event RateLimited(address user, uint256 lastCreationTime);

    /// @notice emitted when a quote token configuration is set
    /// @param quoteToken The address of the quote token
    /// @param config The configuration set for the quote token
    event QuoteTokenConfigurationSet(address quoteToken, QuoteTokenConfiguration config);

    /// @notice emitted when a V3 favored fee is set for a quote token
    /// @param quoteToken The address of the quote token
    /// @param favoredFee The favored fee set for the quote token
    event V3FavoredFeeSet(address quoteToken, uint24 favoredFee);

    /// @notice emitted when a token's DEX preference is set
    /// @param token The address of the token
    /// @param dexId The preferred DEX ID for the token
    /// @param lpFeeProfile The preferred V3 LP fee profile for the token
    event TokenDexPreferenceSet(address token, DEXId dexId, V3LPFeeProfile lpFeeProfile);

    /// @notice emitted when a message is sent
    /// @param sender The address of the sender
    /// @param token The address of the token
    /// @param message The message sent
    event MsgSent(address sender, address token, string message);

    //
    // Custom Errors
    //

    /// @notice error if the dex is both pancake and algebra1.9
    ///         which is impossible
    error DEXCannotBeBothPancakeAndAlgebra1_9();

    /// @notice error if the portal lens address is zero
    error PortalLensCannotBeZero();

    /// @notice error if the multi dex router address is zero
    error MultiDexRouterCannotBeZero();

    /// @notice error if the token does not exist
    error TokenNotFound(address token);

    /// @notice error if the amount is too small
    error AmountTooSmall(uint256 amount);

    /// @notice error if slippage is too high
    /// i.e: actualAmount < minAmount
    error SlippageTooHigh(uint256 actualAmount, uint256 minAmount);

    /// @notice error if the input token & output token of a swap is the same
    error SameToken(address tokenA);

    /// @notice error if trying to trade a killed token
    error TokenKilled(address token);

    /// @notice error if token is not tradable
    error TokenNotTradable(address token);

    /// @notice error if trying to sell a token that is in a battle
    error TokenInDuel(address token);

    /// @notice error if trying to redeem a token that is not killed
    error TokenNotKilled(address token);

    /// @notice error if the token has already been added to the DEX
    error TokenAlreadyDEXed(address token);

    /// @notice error if the token has already been staged or created
    error TokenAlreadyStaged(address token);

    /// @notice error if the token is not in staged status
    error TokenNotStaged(address token);

    /// @notice error if the token is not listed on DEX yet
    error TokenNotDEXed(address token);

    /// @notice error if there is no conversion path from srcToken to dstToken
    error NoConversionPath(address srcToken, address dstToken);

    /// @notice error if the round is not found
    error RoundNotFound(uint256 id);

    /// @notice error if the round id is invalid
    error InvalidRoundID(uint256 id);

    /// @notice error if try to start a new round but the last round is not resolved
    error LastRoundNotResolved();

    /// @notice cannot use a token for the next round of the game
    error InvalidTokenForBattle(address token);

    /// @notice error if the signature is invalid
    error InvalidSigner(address signer);

    /// @notice error if the seq is not found in Game queue
    error SeqNotFound(uint256 seq);

    /// @notice error if not implemented yet
    error NotImplemented();

    /// @notice error a token is already in the game
    error TokenAlreadyInGame(address token);

    /// @notice error if a call reverted but without any data
    error CallReverted();

    /// @notice error if creating token is disabled
    error PermissionlessCreateDisabled();

    /// @notice error if trading is disabled
    error TradeDisabled();

    /// @notice error if the circuit breakers are off
    error ProtocolDisabled();

    /// @notice error if the game supply threshold is not valid
    error InvalidGameSupplyThreshold();

    /// @notice error if the dex supply threshold is not valid
    error InvalidDEXSupplyThreshold();

    /// @notice error if the proof does not match the msg.sender
    error MismatchedAddressInProof(address expected, address actual);

    /// @notice error if the whitlist creator cannot create more tokens
    error NoQuotaForCreator(uint256 created, uint256 max);

    /// @notice error if the piggyback lenght is not valid
    error InvalidPiggybackLength(uint256 expected, uint256 actual);

    /// @notice error if the feature is disabled
    error FeatureDisabled();

    /// @notice error if caller is not authorized (e.g., only SaleForge can call)
    error OnlySaleForge();

    /// @notice error if the quote token is not allowed
    error QuoteTokenNotAllowed(address quoteToken);

    /// @notice error if a native to quote swap is required but not supported
    /// native to quote swap: i.e, swap the input token to the desired quote token
    error NativeToQuoteSwapNotSupported();

    /// @notice error if the native to quote swap v3 fee type is not supported
    /// @param NativeToQuoteSwapType The unsupported native to quote swap type
    error NativeToQuoteSwapFeeTierNotSupported(uint8 NativeToQuoteSwapType);

    /// @notice error if met any dirty bits
    error DirtyBits();

    //
    // Dex Related
    //

    /// @notice error if sqrPriceA is gte than sqrtPriceB
    error PriceAMustLTPriceB(uint160 sqrtPriceA, uint160 sqrtPriceB);

    /// @notice error if the actual amount is more than the expected amount
    error ActualAmountMustLTEAmount(uint256 actualAmount, uint256 amount1);

    /// @notice error if the msg.sender is not a Uniswap V3 pool
    error NotUniswapV3Pool(address sender);

    /// @notice error if the uniswap v2 pool's liquidity is not zero
    error UniswapV2PoolNotZero(address pool, uint256 liquidity);

    /// @notice error if the required token amount for adding Uniswap v2 liquidity is more than the remaining token
    error RequiredTokenMustLTE(uint256 requiredToken, uint256 reserveToken);

    /// @notice revert when calling slot0 of a Uniswap V3 pool failed
    error UniswapV3Slot0Failed();

    /// @notice error if a non-position NFT is received
    error NonPositionNFTReceived(address collection);

    /// @notice error if the provided dex threshold is invalid
    error InvalidDexThreshold(uint256 threshold);

    /// @notice error if the provided address is not a valid pool
    error InvalidPoolAddress(address pool, address expected);

    //
    // staking related
    //

    /// @notice error if the locks are invalid
    error InvalidLocks();

    /// @notice error if staking feature is not enabled
    error StakingDisabled();

    /// @notice error if the operator does not have the roller role
    error NotRoller();

    // operation related

    /// @notice error if the user cannot check in yet
    /// @param next The timestamp when the user can check in again
    error cannotCheckInUntil(uint256 next);

    // misc

    /// @notice error if another token has the same meta
    error MetaAlreadyUsedByOtherToken(string meta);

    /// @notice error if the creation fee is insufficient
    error InsufficientCreationFee(uint256 required, uint256 provided);

    /// @notice error if the provided ETH is insufficient to cover the required fee
    /// @param required The required fee amount
    /// @param provided The provided ETH amount
    error InsufficientFee(uint256 required, uint256 provided);

    /// @notice error if the vanity address requirement is not met
    /// @param token The generated token address
    error VanityAddressRequirementNotMet(address token);

    /// @notice error if the token is not in DEX status
    error TokenNotInDEXStatus(address token);

    /// @notice error if the caller is not the token's beneficiary
    error CallerNotBeneficiary(address caller, address expected);

    /// @notice error if no locks are available for the token
    error NoLocksAvailable(address token);

    /// @notice error if the provided ETH is insufficient to cover the required input amount
    /// @param provided The provided ETH amount
    /// @param required The required ETH amount
    error InsufficientEth(uint256 provided, uint256 required);

    /// @notice error if the provided tax bps is invalid
    /// @param tax The provided tax bps
    error InvalidTaxBps(uint256 tax);

    /// @notice error if the transferFrom call failed
    /// @param token The address of the token
    /// @param from The address from which the tokens were to be transferred
    /// @param amount The amount of tokens that were to be transferred
    error TransferFromFailed(address token, address from, uint256 amount);

    /// @notice error if the migrator type is invalid
    error InvalidMigratorType();

    /// @notice error if the quote token is not native but not using PortalTradeV2
    error QuoteTokenNotNativeButNotUsingTradeV2();

    /// @notice error if the msg.value is less than expected value when creating
    /// a tax token using an ERC20 (e.g: USDC) token as the quote token.
    /// @dev For the tax token's tax splitter to work properly, we need approximately 1gwei due to our
    /// implemenation of the tax splitter.
    error InsufficientValueForTaxTokenCreation(uint256 expected, uint256 provided);

    /// @notice error if the caller is not a guardian or admin
    /// @param caller The address of the caller
    error NotGuardian(address caller);

    /// @notice error if the extension version is not supported
    /// @param version The unsupported extension version
    error UnsupportedExtensionVersion(uint8 version);

    /// @notice error if the token uses an extension but is traded through the legacy PortalTrade contract
    /// @param token The address of the token with an extension
    error TokenWithExtensionNotSupported(address token);

    /// @notice error if the parameters for ToshiMart are invalid
    error InvalidParamsForToshiMart();

    /// @notice error if the parameters for X_LAYER are invalid
    error InvalidParamsForXLayer();

    /// @notice error if the quote token configuration is invalid
    error InvalidQuoteTokenConfiguration();

    /// @notice error when trying to use PortalTrade with tokens that have non-zero h parameter
    error ErrShouldUsePortalTradeV2();

    /// @notice error when no supported DEX is found for the token
    error NoSupportedDEX();

    /// @notice invalid fee tier for DEX
    error InvalidFeeTierForDEX();

    /// @notice error if the tax distribution percentages don't add up to 100%
    error InvalidTaxDistribution();

    /// @notice error if tax duration exceeds maximum allowed
    error TaxDurationTooLong();

    /// @notice error if tax duration is less than minimum allowed
    error TaxDurationTooShort();

    /// @notice error if anti-farmer duration exceeds maximum allowed
    error AntiFarmerDurationTooLong();

    /// @notice error if anti-farmer duration is less than minimum allowed
    error AntiFarmerDurationTooShort();

    /// @notice error if minimum share balance is too low for dividend eligibility
    error MinimumShareBalanceTooLow();

    /// @notice error when dividend parameters are missing but required
    error DividendParametersRequired();

    /// @notice error when user is rate limited from creating tokens
    /// @param user The address that is rate limited
    /// @param lastCreationTime The timestamp of the user's last successful token creation
    error RateLimitExceeded(address user, uint256 lastCreationTime);

    /// @notice error when user is permanently blocked from creating tokens
    /// @param user The address that is blocked
    error SpammerBlocked(address user);

    // --- Salt Locking ---

    /// @notice Emitted when a salt is locked by a user.
    /// @param locker       The address that paid to lock the salt.
    /// @param salt         The CREATE2 salt that was locked.
    /// @param tokenAddress The predicted token address derived from salt + tokenVersion.
    /// @param tokenVersion The TokenVersion enum value the lock applies to.
    /// @param ts           Block timestamp of the lock.
    event FlapSaltLocked(address locker, bytes32 salt, address tokenAddress, uint8 tokenVersion, uint256 ts);

    /// @notice Emitted when a locked salt is consumed by a successful launch.
    /// @param locker       The address that originally locked the salt.
    /// @param salt         The CREATE2 salt that was used.
    /// @param tokenAddress The token address that was launched.
    /// @param tokenVersion The TokenVersion enum value that was locked.
    /// @param ts           Block timestamp of the launch.
    event FlapSaltUsed(address locker, bytes32 salt, address tokenAddress, uint8 tokenVersion, uint256 ts);

    /// @notice msg.value does not equal the required SALT_LOCK_FEE.
    error SaltLockFeeMismatch(uint256 required, uint256 provided);

    /// @notice The salt is already locked by a different address.
    error SaltAlreadyLockedByAnotherUser(bytes32 salt, address existingLocker);

    /// @notice The caller tried to lock a salt they already hold the lock for.
    error SaltAlreadyLockedBySelf(bytes32 salt);

    /// @notice Launch was rejected because the salt is locked by someone other than the caller.
    error FlapSaltLockedByAnotherUser(bytes32 salt, address locker);

    /// @notice Launch was rejected because the locked tokenVersion does not match the one being launched.
    error SaltLockTokenVersionMismatch(bytes32 salt, TokenVersion locked, TokenVersion provided);

    /// @notice The tokenVersion passed to lockSalt() is not currently supported.
    error UnsupportedTokenVersion(TokenVersion provided);
}

/// @notice Callback interface implemented by VaultPortal (or any trusted caller).
///         Portal calls getSaltOwner() when msg.sender == VAULT_PORTAL to resolve the
///         effective user for salt-lock enforcement without changing any parameter structs.
interface ISaltOwnerProvider {
    /// @notice Return the address that should be treated as the salt owner for the current launch.
    /// @dev VaultPortal must set _pendingSaltOwner before delegating into Portal.
    ///      The call is a staticcall so it cannot modify state.
    function getSaltOwner() external view returns (address);
}

/// @title IPortalLauncherTwoStep
/// @notice Interface for the two-step token launch process
interface IPortalLauncherTwoStep is IPortalTypes {
    /// @notice Stage a new token (V5) without creating it yet
    /// @param params The immutable parameters for the new token
    /// @return token The predetermined address of the token
    /// @dev This stages a token by validating parameters and reserving the token address.
    ///      The token contract is not deployed yet. Call commitNewTokenV5 to actually deploy it.
    ///      Extensions are not supported in two-step launch. LP fee profile is always STANDARD.
    /// FIXME: this is not enabled in this version. Will be available once the audit for this part is ready.
    function stageNewTokenV5(StageNewTokenV5Params calldata params) external returns (address token);

    /// @notice Commit a staged token (V5) and create it
    /// @param params The parameters for token deployment (includes salt to identify staged token)
    /// @dev This deploys the token contract and initializes it. The token must have been staged first via stageNewTokenV5.
    ///      The salt and isTaxToken in params must match what was used during staging.
    ///      If taxRate > 0, creates FlapTaxTokenV2, otherwise creates regular token.
    /// FIXME: this is not enabled in this version. Will be available once the audit for this part is ready.
    function commitNewTokenV5(CommitNewTokenV5Params calldata params) external payable;
}

/// @notice Handles token creation and related operations
interface IPortalLauncher is IPortalTypes {
    /// @notice Create a new token (V2) with flexible parameters
    /// @param params The parameters for the new token
    /// @return token The address of the created
    /// @dev due to the implementation limit, when creating a tax token and using an ERC20 token as the quote token,
    /// You need to pay an extra 1gwei native gas token (i.e msg.value = 1 gwei), or you will encounter an InsufficientValueForTaxTokenCreation error
    function newTokenV2(NewTokenV2Params calldata params) external payable returns (address token);

    /// @notice Create a new token (V3) with extension support
    /// @param params The parameters for the new token including extension configuration
    /// @return token The address of the created token
    /// @dev Similar to newTokenV2 but with extension support. Extension hooks will be called if extensionID is non-zero
    function newTokenV3(NewTokenV3Params calldata params) external payable returns (address token);

    /// @notice Create a new token (V4) with DEX ID and LP fee profile support
    /// @param params The parameters for the new token including DEX ID and LP fee profile
    /// @return token The address of the created token
    /// @dev Similar to newTokenV3 but with DEX ID and LP fee profile support. Allows specifying preferred DEX and fee tier
    function newTokenV4(NewTokenV4Params calldata params) external payable returns (address token);

    /// @notice Create a new token (V5) with tax V2 support
    /// @param params The parameters for the new token including advanced tax features
    /// @return token The address of the created token
    /// @dev Similar to newTokenV4 but with support for FlapTaxTokenV2 when taxRate > 0.
    ///      When taxRate is 0, behaves like newTokenV4 (uses regular token or FlapTaxToken).
    ///      When taxRate > 0, creates a FlapTaxTokenV2 with advanced tax distribution features.
    /// FIXME: this is not enabled in this version. Will be available once the audit for this part is ready.
    function newTokenV5(NewTokenV5Params calldata params) external payable returns (address token);

    /// @notice Create a new token (V6) — unified entry point for all token versions.
    /// @param params The parameters for the new token (see NewTokenV6Params).
    /// @return token The address of the created token.
    ///
    /// @dev Dispatch logic based on `params.tokenVersion`:
    ///
    ///   TOKEN_V2_PERMIT (non-tax token):
    ///     - buyTaxRate and sellTaxRate MUST both be 0.
    ///     - commissionReceiver MUST be address(0).
    ///     - Dispatched to PortalLauncherV5 → creates a standard ERC-20 (TOKEN_V2_PERMIT).
    ///
    ///   TOKEN_TAXED (V1 tax token):
    ///     - At least one tax rate must be > 0.
    ///     - buyTaxRate MUST equal sellTaxRate (symmetric rates only).
    ///     - mktBps MUST be 10000 (all tax goes to beneficiary after protocol fee).
    ///     - dividendBps MUST be 0; deflationBps and lpBps MUST be 0.
    ///     - commissionReceiver MUST be address(0) (commission not supported).
    ///     - Dispatched to PortalLauncherV5Tax → creates a FlapTaxToken (TOKEN_TAXED).
    ///
    ///   TOKEN_TAXED_V2 (V2 tax token):
    ///     - At least one tax rate must be > 0.
    ///     - buyTaxRate MUST equal sellTaxRate (symmetric rates only via V5 path).
    ///     - mktBps MUST NOT be 10000 (use TOKEN_TAXED for that case).
    ///     - mktBps + deflationBps + dividendBps + lpBps MUST equal 10000.
    ///     - commissionReceiver MUST be address(0) (commission not supported).
    ///     - Dispatched to PortalLauncherV5Tax → creates a FlapTaxTokenV2 (TOKEN_TAXED_V2).
    ///
    ///   TOKEN_TAXED_V3 (V3 tax token):
    ///     - At least one tax rate must be > 0.
    ///     - Asymmetric rates allowed (buyTaxRate != sellTaxRate is OK).
    ///     - mktBps + deflationBps + dividendBps + lpBps MUST equal 10000.
    ///     - mktBps == 10000 IS allowed (all tax → protocol fee + commission, no marketing).
    ///     - commissionReceiver CAN be non-zero (commission supported).
    ///     - Dispatched to PortalLauncherTaxV3.launchTaxTokenV3 → creates a FlapTaxTokenV3 (TOKEN_TAXED_V3).
    ///
    /// Emits FlapTokenTaxSet (with max rate) AND FlapTokenAsymmetricTaxSet for tax tokens.
    function newTokenV6(NewTokenV6Params calldata params) external payable returns (address token);

    /// @notice Reserve the token address derived from `salt` by paying SALT_LOCK_FEE.
    /// @dev    The caller must pass the `tokenVersion` they intend to lock for.
    ///         Accepted values include the non-tax V3-permit path (typically 0x8888 vanity)
    ///         and the tax V3 path (typically 0x7777 vanity).
    /// @param salt         CREATE2 salt to reserve.
    /// @param tokenVersion Token version to lock for.
    function lockSalt(bytes32 salt, TokenVersion tokenVersion) external payable;

    /// @notice Launch a new token with V4 / PCS Infinity migration support.
    /// @param params The V7 token parameters
    /// @return token The created token address
    function newTokenV7(NewTokenV7Params calldata params) external payable returns (address token);
}

/// @title Portal Lens Interface
/// @notice Handles read-only token state queries
interface IPortalLens is IPortalTypes {
    /// @notice Get token state
    /// @param token  The address of the token
    /// @return state  The state of the token
    function getTokenV2(address token) external view returns (TokenStateV2 memory state);
    /// @notice Get token state (V3)
    /// @param token  The address of the token
    /// @return state  The state of the token (V3)
    function getTokenV3(address token) external view returns (TokenStateV3 memory state);
    /// @notice Get token state (V4)
    /// @param token  The address of the token
    /// @return state  The state of the token (V4) with only 'r' curve parameter
    function getTokenV4(address token) external view returns (TokenStateV4 memory state);
    /// @notice Get token state (V5)
    /// @param token  The address of the token
    /// @return state  The state of the token (V5) with all curve parameters (r, h, k)
    function getTokenV5(address token) external view returns (TokenStateV5 memory state);
    /// @notice Get token state (V6)
    /// @param token  The address of the token
    /// @return state  The state of the token (V6) with all V5 fields plus taxRate, pool, and progress
    function getTokenV6(address token) external view returns (TokenStateV6 memory state);
    /// @notice Get token state (V7)
    /// @param token  The address of the token
    /// @return state  The state of the token (V7) with all V6 fields plus lpFeeProfile
    function getTokenV7(address token) external view returns (TokenStateV7 memory state);
    /// @notice Get token state (V8)
    /// @param token  The address of the token
    /// @return state  The state of the token (V8) with asymmetric buyTaxRate and sellTaxRate
    function getTokenV8(address token) external view returns (TokenStateV8 memory state);
    /// @notice Get token state (V8Safe)
    /// @dev Returns enum-typed fields (TokenStatus, TokenVersion, V3LPFeeProfile, DEXId) as uint8
    ///      instead of their Solidity enum types, preventing ABI-decoding reverts when new enum
    ///      variants are introduced. Use this method when you need forward/backward compatibility
    ///      with future contract upgrades that may add new enum values.
    /// @param token  The address of the token
    /// @return state  The state of the token with enum fields encoded as uint8
    function getTokenV8Safe(address token) external view returns (TokenStateV8Safe memory state);
    /// @notice Get the quote token configuration for a given quote token address
    /// @param quoteToken The address of the quote token
    /// @return config The configuration of the quote token
    function getQuoteTokenConfiguration(address quoteToken)
        external
        view
        returns (QuoteTokenConfiguration memory config);

    /// @notice Get the salt lock entry for a given CREATE2 salt.
    /// @param salt The CREATE2 salt to query.
    /// @return entry The SaltLockEntry (locker == address(0) means unlocked).
    function getSaltLock(bytes32 salt) external view returns (SaltLockEntry memory entry);
}

/// @title IPortalTrade Interface
/// @notice Handles token trading and redemption
interface IPortalTrade is IPortalTypes {
    /// @notice Buy token with ETH on creation
    /// @param token  The address of the token to buy
    /// @param recipient  The address to send the token to
    /// @param inputAmount The amount of ETH to spend
    ///
    /// @dev  This function is mainly for internal use (be delegated called from the portal contract)
    ///       The msg.value can be greater than inputAmount, the excess ETH will not be
    ///       refunded to the caller. They will be charged as a fee.
    ///
    ///       Note: the slippage is not checked in this function.
    ///
    function buyOnCreation(address token, address recipient, uint256 inputAmount)
        external
        payable
        returns (uint256 amount);

    /// @notice Buy token with ETH
    /// @param token  The address of the token to buy
    /// @param recipient  The address to send the token to
    /// @param minAmount  The minimum amount of tokens to buy
    function buy(address token, address recipient, uint256 minAmount) external payable returns (uint256 amount);

    /// @notice Sell token for ETH
    /// @param token  The address of the token to sell
    /// @param amount The amount of tokens to sell
    /// @param minEth The minimum amount of ETH to receive
    function sell(address token, uint256 amount, uint256 minEth) external returns (uint256 eth);

    /// @notice Redeem a killed token for another token
    /// @param srcToken The address of the token to redeem
    /// @param dstToken The address of the token to receive
    /// @param srcAmount The amount of srcToken to redeem
    /// @return dstAmount The amount of dstToken to receive
    function redeem(address srcToken, address dstToken, uint256 srcAmount) external returns (uint256 dstAmount);

    /// @notice Preview the amount of tokens to buy with ETH
    /// @param token  The address of the token to buy
    /// @param eth  The amount of ETH to spend
    /// @return amount  The amount of tokens to buy
    function previewBuy(address token, uint256 eth) external view returns (uint256 amount);

    /// @notice Preview the amount of ETH to receive for selling tokens
    /// @param token  The address of the token to sell
    /// @param amount  The amount of tokens to sell
    /// @return eth  The amount of ETH to receive
    function previewSell(address token, uint256 amount) external view returns (uint256 eth);

    /// @notice Preview redeem
    /// @param srcToken The address of the token to redeem
    /// @param dstToken The address of the token to receive
    /// @param srcAmount The amount of srcToken to redeem
    /// @return dstAmount The amount of dstToken to receive
    function previewRedeem(address srcToken, address dstToken, uint256 srcAmount)
        external
        view
        returns (uint256 dstAmount);
}

/// @title IPortalTradeV2 Interface
/// @notice Handles unified token swaps and quoting
interface IPortalTradeV2 is IPortalTypes {
    /// @notice Emitted when tax is paid on bonding curve for TAX_TOKEN
    /// @param token The address of the token
    /// @param amount The amount of tax paid
    event TaxOnBondingCurvePaid(address indexed token, uint256 amount);

    /// @notice Emitted when tax is paid on bonding curve for TAX_TOKEN_V2
    /// @param token The address of the token
    /// @param amount The amount of tax paid
    event TaxV2OnBondingCurvePaid(address indexed token, uint256 amount);

    /// @notice Parameters for swapping exact input amount for output token
    struct ExactInputParams {
        /// @notice The address of the input token (use address(0) for native asset)
        address inputToken;
        /// @notice The address of the output token (use address(0) for native asset)
        address outputToken;
        /// @notice The amount of input token to swap (in input token decimals)
        uint256 inputAmount;
        /// @notice The minimum amount of output token to receive
        uint256 minOutputAmount;
        /// @notice Optional permit data for the input token (can be empty)
        bytes permitData;
    }

    /// @notice Parameters for swapping exact input amount for output token (V3) with extension support
    struct ExactInputV3Params {
        /// @notice The address of the input token (use address(0) for native asset)
        address inputToken;
        /// @notice The address of the output token (use address(0) for native asset)
        address outputToken;
        /// @notice The amount of input token to swap (in input token decimals)
        uint256 inputAmount;
        /// @notice The minimum amount of output token to receive
        uint256 minOutputAmount;
        /// @notice Optional permit data for the input token (can be empty)
        bytes permitData;
        /// @notice Additional extension specific data to be passed to the extension's `onTrade` method, check the extension's documentation for details on the expected format and content
        bytes extensionData;
    }

    /// @notice Parameters for quoting the output amount for a given input
    struct QuoteExactInputParams {
        /// @notice The address of the input token (use address(0) for native asset)
        address inputToken;
        /// @notice The address of the output token (use address(0) for native asset)
        address outputToken;
        /// @notice The amount of input token to swap (in input token decimals)
        uint256 inputAmount;
    }
    /// @notice Swap exact input amount for output token
    /// @param params The swap parameters
    /// @return outputAmount The amount of output token received
    /// @dev Here are some possible scenarios:
    ///   If the token's reserve is BNB or ETH (i.e: the quote token is the native gas token):
    ///      - BUY: input token is address(0), output token is the token address
    ///      - SELL: input token is the token address, output token is address(0)
    ///   If the token's reserve is another ERC20 token (eg. USD*, i.e, the quote token is an ERC20 token):
    ///      - BUY with USD*: input token is the USD* address, output token is the token address
    ///      - SELL for USD*: input token is the token address, output token is the USD* address
    ///      - BUY with BNB or ETH: input token is address(0), output token is the token address.
    ///        (Note: this requires an internal swap to convert BNB/ETH to USD*, nativeToQuoteSwap must be anabled for this quote token)
    /// Note: Currently, this method supports trading tokens that is either still on the bonding curve or already listed on DEX.

    function swapExactInput(ExactInputParams calldata params) external payable returns (uint256 outputAmount);

    /// @notice Swap exact input amount for output token (V3) with extension support
    /// @param params The swap parameters including extension data
    /// @return outputAmount The amount of output token received
    /// @dev Similar to swapExactInput but with extension support. Extension hooks will be called if the token uses an extension
    function swapExactInputV3(ExactInputV3Params calldata params) external payable returns (uint256 outputAmount);

    /// @notice Quote the output amount for a given input
    /// @param params The quote parameters
    /// @return outputAmount The quoted output amount
    /// @dev refer to the swapExactInput method for the scenarios
    function quoteExactInput(QuoteExactInputParams calldata params) external returns (uint256 outputAmount);
}

/// @title IPortalCore Interface
/// @notice Combines IPortalLauncher and IPortalTrade
interface IPortalCore is IPortalLauncher, IPortalTrade, IPortalTradeV2 {}

/// @title IPortalMigrator Interface
/// @notice Add liquidity from the bonding curve to DEX
/// @dev this is not a public interface of the portal.
///      All the functions of this interface are either called from the portal
///      or from the UniswapV3Pool contract.
interface IPortalMigrator {
    /// @notice Add liquidity to DEX
    /// @param token The address of the token
    /// @dev This is an internal function
    ///      Any dispatch to this function should be checked in portal contract
    ///      This function may be dellegated called from a payable function.
    function luanchToDEX(address token) external payable;
}

/// @title IRoller Interface
/// @notice This acts as the glue between the portal and the flap staking contract
interface IRoller {
    /// @notice The lock the token is using
    enum LockType {
        INVALID_LOCK, // Invalid lock
        UNCX_LOCK, // The UNCX lock
        GOPLUS_UNIV3_LOCK, // The Goplus UNIv3 lock
        TOSHI_LP_LOCK, // The Toshi LP lock
        IZI_LP_LOCK // The IziSwap LP locker
    }

    /// @notice get the locks by token address
    /// @param token The address of the token
    /// @return locks The lock ids of the token
    function getLocks(address token) external view returns (uint256[] memory locks);

    /// @dev deprecated
    function rollv2(bytes calldata packedParams) external;

    /// @notice Revenue Share: Claim LP fees for a vanity token
    /// @param token The address of the token
    /// @return tokenAmount The amount of the token claimed
    /// @return ethAmount The amount of ETH claimed
    /// @dev Only the beneficiary of the token can call this function.
    function claim(address token) external returns (uint256 tokenAmount, uint256 ethAmount);

    /// @notice Allows the default admin to change the beneficiary of a token
    /// @param token The address of the token
    /// @param newBeneficiary The new beneficiary address
    function setTokenBeneficiary(address token, address newBeneficiary) external;

    /// @notice Allows a roller or default admin to claim LP fees on behalf of the beneficiary
    /// @param token The address of the token
    /// @return tokenAmount The amount of the token claimed
    /// @return quoteAmount The amount of quote token (or ETH) claimed
    /// @dev Only the roller or default admin can call this function.
    /// The claimed fee will be sent to the beneficiary of the token.
    function delegateClaim(address token) external returns (uint256 tokenAmount, uint256 quoteAmount);
}

interface IPortalDexRouter {
    // @notice Update the DEX pool information for a token
    // @dev can only be called by DEX_ROUTER_MANAGER_ROLE roles
    function updateTokenPoolInfo(address token, IPortalTypes.PackedDexPool calldata poolInfo) external;
}

/// @title IPortalTweak Interface
/// @notice Handles admin-only configuration operations for the Portal
interface IPortalTweak is IPortalTypes {
    /// @notice Parameters for updating tax token addresses
    struct TaxTokenAddressUpdate {
        /// @notice The address of the tax token to update
        address token;
        /// @notice The new beneficiary address for the tax splitter
        address beneficiary;
        /// @notice The new fee receiver address for the tax splitter
        address feeReceiver;
    }

    /// @notice Emitted when tax token addresses are updated
    /// @param token The address of the tax token
    /// @param beneficiary The new beneficiary address
    /// @param feeReceiver The new fee receiver address
    /// @dev Only Default ADMIN can change this
    event TaxTokenAddressesUpdated(address indexed token, address beneficiary, address feeReceiver);

    /// @notice Set the configuration for a quote token
    /// @dev Only callable by the default admin
    /// @param quoteToken The address of the quote token
    /// @param config The configuration struct for the quote token
    function setQuoteTokenConfiguration(address quoteToken, QuoteTokenConfiguration calldata config) external;

    /// @notice Set the fee exemption status for a list of traders
    /// @dev Only callable by the default admin
    /// @param traders The addresses of the traders to set exemption for
    /// @param isExempted Whether the traders should be exempted from fees
    function setFeeExemption(address[] memory traders, bool isExempted) external;

    /// @notice Get the current buy and sell fee rates
    /// @return buyFeeRate The current buy fee rate in basis points (e.g. 200 = 2%)
    /// @return sellFeeRate The current sell fee rate in basis points (e.g. 200 = 2%)
    function getFeeRate() external view returns (uint256 buyFeeRate, uint256 sellFeeRate);

    /// @notice Set the fee profile for a token
    /// @dev Only callable by DEFAULT_ADMIN_ROLE or TOKEN_FLAP_FEE_SETTER_ROLE
    /// @param token The address of the token
    /// @param feeProfile The fee profile to set
    function setFlapFeeProfile(address token, FlapFeeProfile feeProfile) external;

    /// @notice Update beneficiary and feeReceiver addresses for one or more tax tokens
    /// @dev Only callable by the default admin or TAX_MANAGER_ROLE
    /// @param updates Array of TaxTokenAddressUpdate structs containing token addresses and new addresses
    function updateTaxTokenAddresses(TaxTokenAddressUpdate[] calldata updates) external;

    /// @notice Register an extension for use with the portal
    /// @param extensionId The unique identifier for this extension
    /// @param extensionAddress The address of the extension contract
    /// @param version The version of the extension interface it implements (starting from 1)
    /// @dev Only callable by the default admin
    function registerExtension(bytes32 extensionId, address extensionAddress, uint8 version) external;

    /// @notice Block or unblock multiple addresses from creating tokens
    /// @param spammers The addresses to block or unblock
    /// @param blocked True to block, false to unblock
    /// @dev Only callable by the default admin or MODERATOR_ROLE
    function setSpammerBlockedBatch(address[] calldata spammers, bool blocked) external;

    /// @notice Emitted when stuck tax tokens are recovered from the tax splitter
    /// @param taxToken The address of the tax token
    /// @param amountSentToToken The amount of tokens sent back to the tax token contract
    /// @param amountReturnedToSplitter The amount of tokens returned to the tax splitter
    event StuckTaxTokenRecovered(address indexed taxToken, uint256 amountSentToToken, uint256 amountReturnedToSplitter);

    /// @notice Recover stuck tax tokens from the tax splitter and re-inject up to liquidationThreshold into the token
    /// @dev Only callable by AUDITOR_ROLE. Currently supports V1 (TOKEN_TAXED) tax tokens.
    ///      The name is intentionally generic to allow extension to V2/V3 tax tokens in the future.
    /// @param taxToken The address of the V1 tax token to recover stuck tokens for
    function recoverStuckTaxToken(address taxToken) external;
}

/// @title Portal Interface
/// @notice This interface combines the core and game interfaces
interface IPortal is
    IPortalCore,
    IAccessControlUpgradeable,
    IRoller,
    IPortalDexRouter,
    IPortalTweak,
    IPortalLens,
    IPortalLauncherTwoStep
{
    /// @notice Get the version of the portal
    /// @return The version string
    function version() external view returns (string memory);

    /// @notice Check if tax on bonding curve is enabled
    /// @return enabled True if tax on bonding curve is enabled
    function enableTaxOnBondingCurve() external view returns (bool enabled);

    /// @notice Change the protocol bit flags
    /// @dev Can only be called with DEFAULT_ADMIN_ROLE
    /// @param flags The new flags
    function setBitFlags(uint256 flags) external;

    /// @notice Can only be called by the guardian role or the default admin role
    /// @dev This function is used to pause the protocol
    function halt() external;

    /// @notice Check if an address is blocked from creating tokens
    /// @param spammer The address to check
    /// @return True if the address is blocked
    function isSpammerBlocked(address spammer) external view returns (bool);

    /// @notice Send a message for a token
    /// @param token The address of the token
    /// @param message The message to send
    function sendMsg(address token, string memory message) external;

    /// @notice Get the current nonce of the portal
    function nonce() external view returns (uint256);
}
