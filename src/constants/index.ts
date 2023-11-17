// =============================================================================
// Subtopia JS SDK
// Copyright (C) 2023 Altynbek Orumbayev
// =============================================================================

import { ChainType } from "../enums";
import { AssetMetadata } from "../interfaces";

export const DEFAULT_AWAIT_ROUNDS = 10;
export const TESTNET_SUBTOPIA_REGISTRY_ID = 450888714;
export const MAINNET_SUBTOPIA_REGISTRY_ID = 450888714;
export const SUBTOPIA_REGISTRY_ID = (chainType: ChainType) => {
  if (chainType === ChainType.MAINNET) {
    return TESTNET_SUBTOPIA_REGISTRY_ID;
  } else if (chainType === ChainType.TESTNET) {
    return MAINNET_SUBTOPIA_REGISTRY_ID;
  } else {
    // attempt to load from env variable called SUBTOPIA_REGISTRY_ID
    // throw exception if not found
    try {
      return Number(process.env.SUBTOPIA_REGISTRY_ID);
    } catch (error) {
      throw new Error(
        "SUBTOPIA_REGISTRY_ID environment variable is not set or is not a number"
      );
    }
  }
};

export const ALGO_ASSET = {
  index: 0,
  creator: "",
  name: "ALGO",
  decimals: 6,
  unitName: "ALGO",
} as AssetMetadata;

export const PRODUCT_STATE_MANAGER_KEY = "manager";
export const PRODUCT_VERSION_KEY = "product_version";
export const PRODUCT_APPROVAL_KEY = "product_approval";
export const PRODUCT_CLEAR_KEY = "product_clear";
export const LOCKER_VERSION_KEY = "locker_version";
export const LOCKER_APPROVAL_KEY = "locker_approval";
export const LOCKER_CLEAR_KEY = "locker_clear";

export const MIN_APP_OPTIN_MBR = 0.1; // ALGO
export const MIN_APP_CREATE_MBR = 0.1; // ALGO
export const MIN_ASA_OPTIN_MBR = 0.1; // ALGO
export const MIN_ASA_CREATE_MBR = 0.1; // ALGO

// Platform fees
export const SUBSCRIPTION_PLATFORM_FEE_CENTS = 10;
export const PRODUCT_CREATION_PLATFORM_FEE_CENTS = 500;

// Algorand minimum transaction fee
export const REGISTRY_VERSION = "1.0";
export const PRODUCT_VERSION = "1.0";
export const LOCKER_VERSION = "1.0";
export const ORACLE_VERSION = "1.0";

// Locker creation
export const LOCKER_EXTRA_PAGES = 0;
export const LOCKER_GLOBAL_NUM_UINTS = 1;
export const LOCKER_GLOBAL_NUM_BYTE_SLICES = 1;
export const LOCKER_LOCAL_NUM_UINTS = 0;
export const LOCKER_LOCAL_NUM_BYTE_SLICES = 0;

// Misc
export const DEFAULT_TXN_SIGN_TIMEOUT_SECONDS = 60;
