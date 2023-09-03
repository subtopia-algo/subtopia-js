// =============================================================================
// Subtopia JS SDK
// Copyright (C) 2023 Altynbek Orumbayev
// =============================================================================

import { DiscountType, DurationType, SubscriptionType } from "../enums";

// === Boxes ===

export interface ApplicationSpec {
  approval: Uint8Array;
  clear: Uint8Array;
  globalNumUint: number;
  globalNumByteSlice: number;
  localNumUint: number;
  localNumByteSlice: number;
}

export interface SubscriptionRecord {
  createdAt: Date;
  expiresAt: Date | undefined;
  duration: DurationType;
  subID: number;
  subType: SubscriptionType;
}

export interface BaseDiscountRecord {
  duration: DurationType;
  discountType: DiscountType;
  discountValue: number;
}

export interface DiscountRecord extends BaseDiscountRecord {
  createdAt: Date;
  expiresAt: Date | undefined;
  totalClaims: number;
}
// === Common ===

export interface AssetMetadata {
  index: number;
  creator: string;
  name: string;
  decimals: number;
  unitName: string;
}

export interface DiscountMetadata extends BaseDiscountRecord {
  expiresIn?: number;
}