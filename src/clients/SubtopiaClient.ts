// =============================================================================
// Subtopia JS SDK
// Copyright (C) 2023 Altynbek Orumbayev
// =============================================================================

import algosdk, {
  ABIMethod,
  AtomicTransactionComposer,
  EncodedSignedTransaction,
  algosToMicroalgos,
  decodeAddress,
  decodeObj,
  encodeAddress,
  getApplicationAddress,
  makeAssetTransferTxnWithSuggestedParamsFromObject,
  makeEmptyTransactionSigner,
  makePaymentTxnWithSuggestedParamsFromObject,
  modelsv2,
} from "algosdk";
import AlgodClient from "algosdk/dist/types/client/v2/algod/algod";
import {
  normalizePrice,
  getParamsWithFeeCount,
  calculateLockerCreationMbr,
  calculateRegistryLockerBoxCreateMbr,
  calculateProductDiscountBoxCreateMbr,
  calculateProductSubscriptionBoxCreateMbr,
  optInAsset,
  asyncWithTimeout,
  parseTokenProductGlobalState,
} from "../utils";
import { getAssetByID } from "../utils";
import {
  SUBSCRIPTION_PLATFORM_FEE_CENTS,
  MIN_APP_CREATE_MBR,
  MIN_ASA_CREATE_MBR,
  DEFAULT_TXN_SIGN_TIMEOUT_SECONDS,
  SUBTOPIA_REGISTRY_ID,
  ENCODED_DISCOUNT_BOX_KEY,
} from "../constants";
import {
  PriceNormalizationType,
  DiscountType,
  LifecycleState,
  LockerType,
  ChainType,
} from "../enums";

import {
  getAppById,
  getAppGlobalState,
} from "@algorandfoundation/algokit-utils";
import { TransactionSignerAccount } from "@algorandfoundation/algokit-utils/types/account";
import { SubtopiaRegistryClient } from "./SubtopiaRegistryClient";
import {
  ApplicationSpec,
  AssetMetadata,
  DiscountRecord,
  ProductState,
  SubscriberRecord,
  SubscriptionRecord,
} from "interfaces";

/**
 * The `SubtopiaClient` class is responsible for interacting with a Subtopia Product contracts on the Algorand blockchain.
 * It provides methods for initializing the client, managing the lifecycle of the application, creating and managing subscriptions,
 * and retrieving information about the application and subscriptions.
 */
export class SubtopiaClient {
  productName: string;
  subscriptionName: string;
  algodClient: algosdk.Algodv2;
  creator: TransactionSignerAccount;
  price: number;
  coin: AssetMetadata;
  oracleID: number;
  version: string;
  appID: number;
  appAddress: string;
  appSpec: ApplicationSpec;
  timeout: number;
  registryID: number;

  protected constructor({
    algodClient,
    productName,
    subscriptionName,
    creator,
    appID,
    appAddress,
    appSpec,
    oracleID,
    price,
    coin,
    version,
    timeout,
    registryID,
  }: {
    algodClient: AlgodClient;
    productName: string;
    subscriptionName: string;
    creator: TransactionSignerAccount;
    appSpec: ApplicationSpec;
    appID: number;
    appAddress: string;
    oracleID: number;
    price: number;
    coin: AssetMetadata;
    version: string;
    timeout: number;
    registryID: number;
  }) {
    this.algodClient = algodClient;
    this.productName = productName;
    this.subscriptionName = subscriptionName;
    this.creator = creator;
    this.appID = appID;
    this.appAddress = appAddress;
    this.appSpec = appSpec;
    this.oracleID = oracleID;
    this.price = price;
    this.coin = coin;
    this.version = version;
    this.timeout = timeout;
    this.registryID = registryID;
  }

  /**
   * Initializes a SubtopiaClient instance.
   * Retrieves the product's global state, validates it, and creates a new SubtopiaClient.
   *
   * @param {AlgodClient} algodClient - Algod client for Algorand network interactions.
   * @param {ChainType} chainType - Blockchain network type.
   * @param {number} productID - Product's unique identifier.
   * @param {TransactionSignerAccount} creator - Account for signing transactions.
   * @param {number} timeout - Transaction timeout duration (default is DEFAULT_TXN_SIGN_TIMEOUT_SECONDS).
   * @param {number} registryID - Registry's unique identifier (default is SUBTOPIA_TESTNET).
   *
   * @returns {Promise<SubtopiaClient>} Promise resolving to a SubtopiaClient instance.
   *
   * @example
   * ```typescript
   * import { SubtopiaClient } from "@algorand/subtopia";
   *
   * const subtopiaClient = await SubtopiaClient.init({
   *   algodClient: algodClient,
   *   productID: productID,
   *   creator: creator
   * });
   * ```
   */
  public static async init({
    algodClient,
    chainType,
    registryID,
    productID,
    creator,
    timeout = DEFAULT_TXN_SIGN_TIMEOUT_SECONDS,
  }: {
    algodClient: AlgodClient;
    chainType: ChainType;
    productID: number;
    creator: TransactionSignerAccount;
    registryID?: number;
    timeout?: number;
  }): Promise<SubtopiaClient> {
    const registryId = registryID
      ? registryID
      : SUBTOPIA_REGISTRY_ID(chainType);

    const rawProductGlobalState = await getAppGlobalState(
      productID,
      algodClient
    ).catch((error) => {
      throw new Error(error);
    });
    const productGlobalState = parseTokenProductGlobalState(
      rawProductGlobalState
    );

    if (!productGlobalState.oracle_id) {
      throw new Error("Oracle missing, cannot initialize");
    }

    const oracleID = productGlobalState.oracle_id;
    const productAddress = getApplicationAddress(productID);
    const productPrice = productGlobalState.price;
    const productSpec = await getAppById(productID, algodClient);
    const productName = productGlobalState.product_name;
    const subscriptionName = productGlobalState.subscription_name;

    const versionAtc = new AtomicTransactionComposer();

    versionAtc.addMethodCall({
      appID: productID,
      method: new ABIMethod({
        name: "get_version",
        args: [],
        returns: { type: "string" },
      }),
      sender: creator.addr,
      signer: makeEmptyTransactionSigner(),
      suggestedParams: await getParamsWithFeeCount(algodClient, 1),
    });

    const group = versionAtc
      .buildGroup()
      .map((txn) => algosdk.encodeUnsignedSimulateTransaction(txn.txn));

    const request = new modelsv2.SimulateRequest({
      allowEmptySignatures: true,
      txnGroups: [
        new modelsv2.SimulateRequestTransactionGroup({
          // Must decode the signed txn bytes into an object
          txns: group.map((txn) =>
            decodeObj(txn)
          ) as EncodedSignedTransaction[],
        }),
      ],
    });

    const response = await versionAtc.simulate(algodClient, request);
    const version = response.methodResults[0].returnValue as string;
    const coin = await getAssetByID(algodClient, productGlobalState.coin_id);

    return new SubtopiaClient({
      algodClient,
      creator,
      appID: productID,
      productName: productName,
      subscriptionName: subscriptionName,
      appAddress: productAddress,
      appSpec: {
        approval: productSpec.params.approvalProgram,
        clear: productSpec.params.clearStateProgram,
        globalNumUint:
          Number(productSpec.params.globalStateSchema?.numUint) || 0,
        globalNumByteSlice:
          Number(productSpec.params.globalStateSchema?.numByteSlice) || 0,
        localNumUint: Number(productSpec.params.localStateSchema?.numUint) || 0,
        localNumByteSlice:
          Number(productSpec.params.localStateSchema?.numByteSlice) || 0,
      },
      oracleID,
      price: productPrice,
      coin,
      version,
      timeout,
      registryID: registryId,
    });
  }

  /**
   * This method is used to update the lifecycle state of the application.
   * The method returns the transaction ID.
   * @param {LifecycleState} lifecycle - The new lifecycle state.
   * @returns {Promise<{txID: string}>} A promise that resolves to an object containing the transaction ID.
   */
  protected async updateLifecycle({
    lifecycle,
  }: {
    lifecycle: LifecycleState;
  }): Promise<{
    txID: string;
  }> {
    const updateLifecycleAtc = new AtomicTransactionComposer();
    updateLifecycleAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "update_lifecycle",
        args: [
          {
            type: "uint64",
            name: "lifecycle",
            desc: "The new lifecycle.",
          },
        ],
        returns: { type: "void" },
      }),
      methodArgs: [lifecycle],
      sender: this.creator.addr,
      signer: this.creator.signer,
      suggestedParams: await getParamsWithFeeCount(this.algodClient, 1),
    });

    const response = await asyncWithTimeout(
      updateLifecycleAtc.execute.bind(updateLifecycleAtc),
      this.timeout,
      this.algodClient,
      10
    );

    return {
      txID: response.txIDs.pop() as string,
    };
  }

  /**
   * This method is used to enable the application (updates the lifecycle).
   * The method returns the transaction ID.
   * @returns {Promise<{txID: string}>} A promise that resolves to an object containing the transaction ID.
   */
  public async enable(): Promise<{
    txID: string;
  }> {
    return this.updateLifecycle({ lifecycle: LifecycleState.ENABLED });
  }

  /**
   * This method is utilized to deactivate the application by updating the lifecycle.
   * It should be invoked prior to the deletion of the application. Once deactivated, the product will cease to allow
   * new subscriptions to be purchased, and existing subscribers will only have the option to cancel their subscriptions.
   * The product can be deleted once all subscriptions have been cancelled or have expired.
   * The method returns the transaction ID.
   * @returns {Promise<{txID: string}>} A promise that resolves to an object containing the transaction ID.
   */
  public async disable(): Promise<{
    txID: string;
  }> {
    return this.updateLifecycle({ lifecycle: LifecycleState.DISABLED });
  }

  /**
   * Retrieves the current state of the application.
   * Returns an object containing various details about the product such as product name, subscription name, manager, price, total subscriptions, maximum subscriptions, coin ID, subscription type, lifecycle, creation time, oracle ID, unit name, image URL, and discount.
   * @param {boolean} parseWholeUnits - Specifies whether to parse the whole units (default is true).
   * @returns {Promise<ProductState>} A promise that resolves to an object representing the current state of the application.
   */
  public async getAppState(parseWholeUnits = true): Promise<ProductState> {
    const rawGlobalState = await getAppGlobalState(
      this.appID,
      this.algodClient
    ).catch((error) => {
      throw new Error(error);
    });
    const globalState = parseTokenProductGlobalState(rawGlobalState);

    const discount = await this.getDiscount();

    return {
      productName: String(globalState.product_name),
      subscriptionName: String(globalState.subscription_name),
      manager: globalState.manager,
      price: parseWholeUnits
        ? normalizePrice(
            Number(globalState.price),
            this.coin.decimals,
            PriceNormalizationType.PRETTY
          )
        : Number(globalState.price),
      totalSubs: Number(globalState.total_subscribers),
      maxSubs: Number(globalState.max_subscribers),
      coinID: Number(globalState.coin_id),
      productType: Number(globalState.product_type),
      lifecycle: Number(globalState.lifecycle),
      createdAt: Number(globalState.created_at),
      duration: Number(globalState.duration),
      oracleID: Number(globalState.oracle_id),
      unitName: String(globalState.unit_name),
      imageURL: String(globalState.image_url),
      discount: discount,
    };
  }

  /**
   * This method calculates the platform fee for a subscription.
   * It returns the platform fee as a number.
   * @returns {Promise<number>} A promise that resolves to the platform fee.
   */
  public async getSubscriptionPlatformFee(): Promise<number> {
    if (this.price === 0) {
      return new Promise((resolve) => resolve(0));
    }

    const priceInCents = SUBSCRIPTION_PLATFORM_FEE_CENTS;
    const computePlatformFeeAtc = new AtomicTransactionComposer();
    computePlatformFeeAtc.addMethodCall({
      appID: this.oracleID,
      method: new ABIMethod({
        name: "compute_platform_fee",
        args: [
          {
            type: "uint64",
            name: "whole_usd",
            desc: "Amount of USD in whole numbers (CENTS)",
          },
        ],
        returns: { type: "uint64" },
      }),
      methodArgs: [priceInCents],
      sender: this.creator.addr,
      signer: makeEmptyTransactionSigner(),
      suggestedParams: await getParamsWithFeeCount(this.algodClient, 1),
    });

    const group = computePlatformFeeAtc
      .buildGroup()
      .map((txn) => algosdk.encodeUnsignedSimulateTransaction(txn.txn));

    const request = new modelsv2.SimulateRequest({
      allowEmptySignatures: true,
      txnGroups: [
        new modelsv2.SimulateRequestTransactionGroup({
          // Must decode the signed txn bytes into an object
          txns: group.map((txn) =>
            decodeObj(txn)
          ) as EncodedSignedTransaction[],
        }),
      ],
    });

    const response = await computePlatformFeeAtc.simulate(
      this.algodClient,
      request
    );

    return Number(response.methodResults[0].returnValue);
  }

  /**
   * This method calculates the locker creation fee.
   * It requires the creator's address as an input and returns a promise that resolves to the calculated fee amount.
   * @param {string} creatorAddress - The address of the locker's creator.
   * @returns {Promise<number>} A promise that resolves to the calculated locker creation fee.
   */
  public async getLockerCreationFee(creatorAddress: string): Promise<number> {
    return (
      algosToMicroalgos(MIN_APP_CREATE_MBR) +
      calculateLockerCreationMbr() +
      calculateRegistryLockerBoxCreateMbr(creatorAddress)
    );
  }

  /**
   * This method retrieves the discount based on a given duration.
   * It accepts a duration object as an argument and returns a promise that resolves to a DiscountRecord.
   * @param {Duration} duration - The duration for which the discount is to be retrieved.
   * @returns {Promise<DiscountRecord>} A promise that resolves to the discount record.
   */
  public async getDiscount(): Promise<DiscountRecord | undefined> {
    const getDiscountAtc = new AtomicTransactionComposer();
    getDiscountAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "get_discount",
        args: [],
        returns: {
          type: "(uint64,uint64,uint64,uint64,uint64)",
          desc: "An expression that returns the discount.",
        },
        desc: "Returns the discount if exists.",
      }),
      methodArgs: [],
      boxes: [
        {
          appIndex: this.appID,
          name: ENCODED_DISCOUNT_BOX_KEY,
        },
      ],
      sender: this.creator.addr,
      signer: makeEmptyTransactionSigner(),
      suggestedParams: await getParamsWithFeeCount(this.algodClient, 1),
    });

    const group = getDiscountAtc
      .buildGroup()
      .map((txn) => algosdk.encodeUnsignedSimulateTransaction(txn.txn));

    const request = new modelsv2.SimulateRequest({
      allowEmptySignatures: true,
      txnGroups: [
        new modelsv2.SimulateRequestTransactionGroup({
          // Must decode the signed txn bytes into an object
          txns: group.map((txn) =>
            decodeObj(txn)
          ) as EncodedSignedTransaction[],
        }),
      ],
    });

    const response = await getDiscountAtc.simulate(this.algodClient, request);
    const rawContent = response.methodResults[0].returnValue?.valueOf();

    if (!rawContent) {
      return undefined;
    }

    const boxContent: Array<number> = Array.isArray(rawContent)
      ? rawContent.map((value) => Number(value))
      : [];

    if (boxContent.length !== 5) {
      throw new Error("Invalid subscription record");
    }

    return {
      discountType: boxContent[0],
      discountValue: boxContent[1],
      expiresAt: boxContent[2] === 0 ? null : boxContent[2],
      createdAt: boxContent[3],
      totalClaims: boxContent[4],
    };
  }

  /**
   * This function creates a discount for a subscription and returns the transaction ID.
   * @param {DiscountType} discountType - Specifies the type of discount (percentage or amount).
   * @param {number} discountValue - The value of the discount in micro ALGOs.
   * @param {number} expiresIn - The duration of the discount in seconds from the creation date.
   * @param {boolean} parseWholeUnits - Optional. If true, the function parses the whole units. Default is false.
   * @returns {Promise<{txID: string}>} A promise that resolves to an object containing the transaction ID.
   */
  public async createDiscount({
    discountType,
    discountValue,
    expiresIn,
    parseWholeUnits = false,
  }: {
    discountType: DiscountType;
    discountValue: number;
    expiresIn: number;
    parseWholeUnits?: boolean;
  }): Promise<{
    txID: string;
  }> {
    const createDiscountAtc = new AtomicTransactionComposer();
    createDiscountAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "create_discount",
        args: [
          {
            type: "uint64",
            name: "discount_type",
            desc: "The type of discount (percentage or amount).",
          },
          {
            type: "uint64",
            name: "discount_value",
            desc: "The discount value in micro ALGOs.",
          },
          {
            type: "uint64",
            name: "expires_in",
            desc: "The number of seconds to append to creation date",
          },
          {
            type: "pay",
            name: "fee_txn",
            desc: "The transaction fee.",
          },
        ],
        returns: { type: "void" },
      }),
      methodArgs: [
        discountType.valueOf(),
        parseWholeUnits
          ? normalizePrice(
              discountValue,
              this.coin.decimals,
              PriceNormalizationType.RAW
            )
          : discountValue,
        expiresIn,
        {
          txn: makePaymentTxnWithSuggestedParamsFromObject({
            from: this.creator.addr,
            to: this.appAddress,
            amount: calculateProductDiscountBoxCreateMbr(),
            suggestedParams: await getParamsWithFeeCount(this.algodClient, 0),
          }),
          signer: this.creator.signer,
        },
      ],
      boxes: [
        {
          appIndex: this.appID,
          name: ENCODED_DISCOUNT_BOX_KEY,
        },
      ],
      sender: this.creator.addr,
      signer: this.creator.signer,
      suggestedParams: await getParamsWithFeeCount(this.algodClient, 2),
    });

    const response = await asyncWithTimeout(
      createDiscountAtc.execute.bind(createDiscountAtc),
      this.timeout,
      this.algodClient,
      10
    );

    return {
      txID: response.txIDs.pop() as string,
    };
  }

  /**
   * This method is used to delete a discount.
   * Removes active discount from a product contract if exists.
   * @returns {Promise<{txID: string}>} A promise that resolves to an object containing the transaction ID.
   */
  public async deleteDiscount(): Promise<{
    txID: string;
  }> {
    const deleteDiscountAtc = new AtomicTransactionComposer();
    deleteDiscountAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "delete_discount",
        args: [],
        returns: { type: "void" },
      }),
      methodArgs: [],
      boxes: [
        {
          appIndex: this.appID,
          name: ENCODED_DISCOUNT_BOX_KEY,
        },
      ],
      sender: this.creator.addr,
      signer: this.creator.signer,
      suggestedParams: await getParamsWithFeeCount(this.algodClient, 2),
    });

    const response = await asyncWithTimeout(
      deleteDiscountAtc.execute.bind(deleteDiscountAtc),
      this.timeout,
      this.algodClient,
      10
    );

    return {
      txID: response.txIDs.pop() as string,
    };
  }

  /**
   * This method is utilized to initiate a subscription.
   * It accepts a subscriber as an argument and returns a promise that resolves to an object containing the transaction ID and subscription ID.
   * @param {TransactionSignerAccount} subscriber - Account information of the subscriber.
   * @returns {Promise<{txID: string, subscriptionID: number}>} A promise that resolves to an object containing the transaction ID and subscription ID.
   */
  public async createSubscription({
    subscriber,
  }: {
    subscriber: TransactionSignerAccount;
  }): Promise<{
    txID: string;
    subscriptionID: number;
  }> {
    const oracleAdminState = (
      await getAppGlobalState(this.oracleID, this.algodClient)
    ).admin;
    const adminAddress = encodeAddress(
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore
      oracleAdminState.valueRaw
    );
    const platformFeeAmount = await this.getSubscriptionPlatformFee();
    const state = await this.getAppState(false);
    const managerLockerID = await SubtopiaRegistryClient.getLocker({
      registryID: this.registryID,
      algodClient: this.algodClient,
      ownerAddress: state.manager,
      lockerType: LockerType.CREATOR,
    });

    if (!managerLockerID) {
      throw new Error("Creator locker is not initialized");
    }

    const lockerAddress = getApplicationAddress(managerLockerID);

    let subscriptionPrice = this.price;
    if (state.discount) {
      if (state.discount.discountType === DiscountType.PERCENTAGE) {
        subscriptionPrice =
          subscriptionPrice -
          (subscriptionPrice * state.discount.discountValue) / 100;
      } else if (state.discount.discountType === DiscountType.FIXED) {
        subscriptionPrice = subscriptionPrice - state.discount.discountValue;
      }
    }

    const currentSubscription = await this.getSubscription({
      algodClient: this.algodClient,
      subscriberAddress: subscriber.addr,
    }).catch(() => {
      return null;
    });
    const isHoldingSubscription = currentSubscription !== null;
    const isActiveSubscriber = await this.isSubscriber({
      subscriberAddress: subscriber.addr,
    });
    const isHoldingExpiredSubscription =
      isHoldingSubscription && !isActiveSubscriber;

    const createSubscriptionAtc = new AtomicTransactionComposer();
    createSubscriptionAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "create_subscription",
        args: [
          {
            type: "address",
            name: "subscriber",
            desc: "The subscriber's address.",
          },
          {
            type: "application",
            name: "creator_locker",
            desc: "The locker of creator",
          },
          {
            type: "application",
            name: "oracle_id",
            desc: "The oracle app used.",
          },
          {
            type: "pay",
            name: "fee_txn",
            desc: "The transaction fee paid to the app.",
          },
          {
            type: "pay",
            name: "platform_fee_txn",
            desc: "The platform fee paid.",
          },
          {
            type: "txn",
            name: "pay_txn",
            desc: "The payment transaction to fund the subscription.",
          },
        ],
        returns: { type: "uint64" },
      }),
      methodArgs: [
        subscriber.addr,
        managerLockerID,
        this.oracleID,
        {
          txn: makePaymentTxnWithSuggestedParamsFromObject({
            from: subscriber.addr,
            to: this.appAddress,
            amount: isHoldingExpiredSubscription
              ? 0
              : calculateProductSubscriptionBoxCreateMbr(subscriber.addr) +
                algosToMicroalgos(MIN_ASA_CREATE_MBR),
            suggestedParams: await getParamsWithFeeCount(this.algodClient, 0),
          }),
          signer: subscriber.signer,
        },
        {
          txn: makePaymentTxnWithSuggestedParamsFromObject({
            from: subscriber.addr,
            to: adminAddress,
            amount: this.price > 0 ? platformFeeAmount : 0,
            suggestedParams: await getParamsWithFeeCount(this.algodClient, 0),
          }),
          signer: subscriber.signer,
        },
        this.coin.index === 0
          ? {
              txn: makePaymentTxnWithSuggestedParamsFromObject({
                from: subscriber.addr,
                to: lockerAddress,
                amount: subscriptionPrice,
                suggestedParams: await getParamsWithFeeCount(
                  this.algodClient,
                  0
                ),
              }),
              signer: subscriber.signer,
            }
          : {
              txn: makeAssetTransferTxnWithSuggestedParamsFromObject({
                from: subscriber.addr,
                to: lockerAddress,
                amount: subscriptionPrice,
                assetIndex: this.coin.index,
                suggestedParams: await getParamsWithFeeCount(
                  this.algodClient,
                  0
                ),
              }),
              signer: subscriber.signer,
            },
      ],
      boxes: [
        {
          appIndex: this.appID,
          name: decodeAddress(subscriber.addr).publicKey,
        },
        {
          appIndex: this.appID,
          name: ENCODED_DISCOUNT_BOX_KEY,
        },
      ],
      sender: subscriber.addr,
      signer: subscriber.signer,
      suggestedParams: await getParamsWithFeeCount(
        this.algodClient,
        this.coin.index > 0 ? 6 : 5
      ),
    });

    const response = await asyncWithTimeout(
      createSubscriptionAtc.execute.bind(createSubscriptionAtc),
      this.timeout,
      this.algodClient,
      10
    ).catch((error) => {
      throw new Error(error);
    });

    return {
      txID: response.txIDs.pop() as string,
      subscriptionID: Number(response.methodResults[0].returnValue),
    };
  }

  /**
   * Transfers a subscription from one subscriber to another.
   *
   * @param {TransactionSignerAccount} oldSubscriber - Account information of the current subscriber.
   * @param {string} newSubscriberAddress - Address of the new subscriber.
   * @param {number} subscriptionID - Unique identifier of the subscription to be transferred.
   *
   * @returns {Promise<{txID: string}>} A promise that resolves to an object containing the transaction ID of the transfer operation.
   */
  public async transferSubscription({
    oldSubscriber,
    newSubscriberAddress,
    subscriptionID,
  }: {
    oldSubscriber: TransactionSignerAccount;
    newSubscriberAddress: string;
    subscriptionID: number;
  }): Promise<{
    txID: string;
  }> {
    const transferSubscriptionAtc = new AtomicTransactionComposer();
    transferSubscriptionAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "transfer_subscription",
        args: [
          {
            type: "address",
            name: "new_subscriber",
            desc: "The new address to transfer the subscription to.",
          },
          {
            type: "asset",
            name: "subscription",
            desc: "The subscription asset.",
          },
        ],
        returns: { type: "void" },
      }),
      boxes: [
        {
          appIndex: this.appID,
          name: decodeAddress(oldSubscriber.addr).publicKey,
        },
        {
          appIndex: this.appID,
          name: decodeAddress(newSubscriberAddress).publicKey,
        },
      ],
      methodArgs: [newSubscriberAddress, subscriptionID],
      sender: oldSubscriber.addr,
      signer: oldSubscriber.signer,
      suggestedParams: await getParamsWithFeeCount(this.algodClient, 2),
    });

    const response = await asyncWithTimeout(
      transferSubscriptionAtc.execute.bind(transferSubscriptionAtc),
      this.timeout,
      this.algodClient,
      10
    );

    return {
      txID: response.txIDs.pop() as string,
    };
  }

  /**
   * Claims a subscription for a given subscriber.
   *
   * @param {Object} subscriber - The account of the subscriber, containing the address and signer.
   * @param {number} subscriptionID - The ID of the subscription asset.
   * @returns {Promise<Object>} - The transaction ID of the executed transaction.
   */
  public async claimSubscription({
    subscriber,
    subscriptionID,
  }: {
    subscriber: TransactionSignerAccount;
    subscriptionID: number;
  }): Promise<{
    txID: string;
  }> {
    const assetInfo = await this.algodClient
      .accountAssetInformation(subscriber.addr, subscriptionID)
      .do()
      .catch(() => {
        return null;
      });

    if (!assetInfo) {
      await optInAsset({
        client: this.algodClient,
        account: subscriber,
        assetID: subscriptionID,
      });
    }

    const claimSubscriptionAtc = new AtomicTransactionComposer();
    claimSubscriptionAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "claim_subscription",
        args: [
          {
            type: "asset",
            name: "subscription",
            desc: "The subscription ASA ID.",
          },
        ],
        returns: { type: "void" },
      }),
      methodArgs: [subscriptionID],
      boxes: [
        {
          appIndex: this.appID,
          name: decodeAddress(subscriber.addr).publicKey,
        },
      ],
      sender: subscriber.addr,
      signer: subscriber.signer,
      suggestedParams: await getParamsWithFeeCount(this.algodClient, 2),
    });

    const response = await asyncWithTimeout(
      claimSubscriptionAtc.execute.bind(claimSubscriptionAtc),
      this.timeout,
      this.algodClient,
      10
    );

    return {
      txID: response.txIDs.pop() as string,
    };
  }

  /**
   * This method is used to delete a subscription.
   * It takes a subscriber and a subscription ID as arguments and returns a promise that resolves to an object containing the transaction ID.
   * @param {TransactionSignerAccount} subscriber - The subscriber's account.
   * @param {number} subscriptionID - The ID of the subscription to be deleted.
   * @returns {Promise<{txID: string}>} A promise that resolves to an object containing the transaction ID.
   */
  public async deleteSubscription({
    subscriber,
    subscriptionID,
  }: {
    subscriber: TransactionSignerAccount;
    subscriptionID: number;
  }): Promise<{
    txID: string;
  }> {
    let isHoldingSubscription = false;
    const assetInfo = await this.algodClient
      .accountAssetInformation(subscriber.addr, subscriptionID)
      .do()
      .catch(() => {
        isHoldingSubscription = false;
      });
    if (assetInfo) {
      isHoldingSubscription = assetInfo["asset-holding"].amount > 0;
    }

    const deleteSubscriptionAtc = new AtomicTransactionComposer();
    deleteSubscriptionAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "delete_subscription",
        args: [
          {
            type: "asset",
            name: "subscription",
            desc: "The subscription ASA ID.",
          },
        ],
        returns: { type: "uint64" },
      }),
      methodArgs: [subscriptionID],
      boxes: [
        {
          appIndex: this.appID,
          name: decodeAddress(subscriber.addr).publicKey,
        },
      ],
      sender: subscriber.addr,
      signer: subscriber.signer,
      suggestedParams: await getParamsWithFeeCount(
        this.algodClient,
        isHoldingSubscription ? 4 : 3
      ),
    });

    const response = await asyncWithTimeout(
      deleteSubscriptionAtc.execute.bind(deleteSubscriptionAtc),
      this.timeout,
      this.algodClient,
      10
    );

    return {
      txID: response.txIDs.pop() as string,
    };
  }

  /**
   * Checks if a given address is a subscriber.
   *
   * @param {Object} subscriberAddress - The address of the potential subscriber.
   * @returns {Promise<boolean>} - A promise that resolves to a boolean indicating whether the address is a subscriber.
   */
  public async isSubscriber({
    subscriberAddress,
  }: {
    subscriberAddress: string;
  }): Promise<boolean> {
    const isSubscriberAtc = new AtomicTransactionComposer();
    isSubscriberAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "is_subscriber",
        args: [
          {
            type: "address",
            name: "subscriber",
            desc: "The subscriber address.",
          },
        ],
        returns: { type: "uint64" },
      }),
      methodArgs: [subscriberAddress],
      sender: this.creator.addr,
      signer: makeEmptyTransactionSigner(),
      boxes: [
        {
          appIndex: this.appID,
          name: decodeAddress(subscriberAddress).publicKey,
        },
      ],
      suggestedParams: await getParamsWithFeeCount(this.algodClient, 1),
    });

    const group = isSubscriberAtc
      .buildGroup()
      .map((txn) => algosdk.encodeUnsignedSimulateTransaction(txn.txn));

    const request = new modelsv2.SimulateRequest({
      allowEmptySignatures: true,
      txnGroups: [
        new modelsv2.SimulateRequestTransactionGroup({
          // Must decode the signed txn bytes into an object
          txns: group.map((txn) =>
            decodeObj(txn)
          ) as EncodedSignedTransaction[],
        }),
      ],
    });

    const response = await isSubscriberAtc.simulate(this.algodClient, request);

    return Boolean(response.methodResults[0].returnValue);
  }

  /**
   * This method is used to get a subscription.
   * It takes an AlgodClient and a subscriber address as arguments and returns a promise that resolves to a SubscriptionRecord.
   * @param {AlgodClient} algodClient - The AlgodClient to use for the transaction.
   * @param {string} subscriberAddress - The address of the subscriber.
   * @returns {Promise<SubscriptionRecord>} A promise that resolves to a SubscriptionRecord.
   */
  public async getSubscription({
    algodClient,
    subscriberAddress,
  }: {
    algodClient: AlgodClient;
    subscriberAddress: string;
  }): Promise<SubscriptionRecord> {
    const getSubscriptionAtc = new AtomicTransactionComposer();
    getSubscriptionAtc.addMethodCall({
      appID: this.appID,
      method: new ABIMethod({
        name: "get_subscription",
        args: [
          {
            type: "address",
            name: "subscriber",
            desc: "The subscriber address.",
          },
        ],
        returns: { type: "(uint64,uint64,uint64,uint64,uint64)" },
      }),
      methodArgs: [subscriberAddress],
      sender: this.creator.addr,
      signer: makeEmptyTransactionSigner(),
      boxes: [
        {
          appIndex: this.appID,
          name: decodeAddress(subscriberAddress).publicKey,
        },
      ],
      suggestedParams: await getParamsWithFeeCount(algodClient, 1),
    });

    const group = getSubscriptionAtc
      .buildGroup()
      .map((txn) => algosdk.encodeUnsignedSimulateTransaction(txn.txn));

    const request = new modelsv2.SimulateRequest({
      allowEmptySignatures: true,
      txnGroups: [
        new modelsv2.SimulateRequestTransactionGroup({
          // Must decode the signed txn bytes into an object
          txns: group.map((txn) =>
            decodeObj(txn)
          ) as EncodedSignedTransaction[],
        }),
      ],
    });

    const response = await getSubscriptionAtc.simulate(algodClient, request);
    const boxContent: Array<number> = (
      response.methodResults[0].returnValue?.valueOf() as Array<number>
    ).map((value) => Number(value));

    if (boxContent.length !== 5) {
      throw new Error("Invalid subscription record");
    }

    return {
      subType: boxContent[0],
      subID: boxContent[1],
      createdAt: boxContent[2],
      expiresAt: boxContent[3] === 0 ? null : boxContent[3],
      duration: boxContent[4],
    };
  }

  public async getSubscribers({ filterExpired = false } = {}): Promise<
    Array<SubscriberRecord>
  > {
    const subscriberBoxes = await this.algodClient
      .getApplicationBoxes(this.appID)
      .do();

    const promises = subscriberBoxes.boxes.map(async (box) => {
      const address = encodeAddress(box.name);
      const subscription = this.getSubscription({
        algodClient: this.algodClient,
        subscriberAddress: address,
      });
      return {
        address: address,
        subscription: await subscription,
      };
    });

    const results = await Promise.allSettled(promises);

    const subscriberRecords: Array<SubscriberRecord> = results
      .filter((result) => result.status === "fulfilled")
      .map(
        (result) => (result as PromiseFulfilledResult<SubscriberRecord>).value
      );

    const rejectedPromises = results
      .filter((result) => result.status === "rejected")
      .map((result) => (result as PromiseRejectedResult).reason);

    if (rejectedPromises.length > 0) {
      throw new Error(`Errors occurred: ${rejectedPromises.join(", ")}`);
    }

    return filterExpired
      ? subscriberRecords.filter((record) => {
          return (
            record.subscription.expiresAt === null ||
            record.subscription.expiresAt > Date.now() / 1000
          );
        })
      : subscriberRecords;
  }
}
