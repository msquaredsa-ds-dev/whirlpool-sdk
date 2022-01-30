import { getPositionPda, sqrtPriceX64ToTickIndex, toX64 } from "@orca-so/whirlpool-client-sdk";
import WhirlpoolClient from "@orca-so/whirlpool-client-sdk/dist/client";
import WhirlpoolContext from "@orca-so/whirlpool-client-sdk/dist/context";
import {
  PositionData,
  TICK_ARRAY_SIZE,
  WhirlpoolData,
} from "@orca-so/whirlpool-client-sdk/dist/types/anchor-types";
import { TransactionBuilder } from "@orca-so/whirlpool-client-sdk/dist/utils/transactions/transactions-builder";
import { MintInfo } from "@solana/spl-token";
import { Keypair, PublicKey } from "@solana/web3.js";
import invariant from "tiny-invariant";
import {
  AddLiquidityQuote,
  ClosePositionQuote,
  ClosePositionQuoteParam,
  ClosePositionTransactionParam,
  OpenPositionQuote,
  OpenPositionQuoteParam,
  OpenPositionTransactionParam,
  SwapQuote,
  SwapQuoteParam,
  SwapTransactionParam,
} from "..";
import { defaultSlippagePercentage } from "../constants/defaults";
import { OrcaDAL } from "../dal/orca-dal";
import { OrcaPosition } from "../position/orca-position";
import {
  getAddLiquidityQuoteWhenPositionIsAboveRange,
  getAddLiquidityQuoteWhenPositionIsBelowRange,
  getAddLiquidityQuoteWhenPositionIsInRange,
  InternalAddLiquidityQuoteParam,
} from "../position/quotes/add-liquidity";
import { MultiTransactionBuilder } from "../utils/public/multi-transaction-builder";
import { deriveATA, resolveOrCreateATA } from "../utils/web3/ata-utils";
import { PoolUtil } from "../utils/whirlpool/pool-util";
import { PositionStatus, PositionUtil } from "../utils/whirlpool/position-util";
import { TickArrayOutOfBoundsError, TickUtil } from "../utils/whirlpool/tick-util";
import { AmountSpecified, SwapDirection, SwapSimulator } from "./quotes/swap-quoter";

export class OrcaWhirlpool {
  constructor(private readonly dal: OrcaDAL) {}

  /*** Transactions (public) ***/

  /** 1. Open position tx **/
  // TODO adding liquidity should be optional
  public async getOpenPositionTransaction(
    param: OpenPositionTransactionParam
  ): Promise<MultiTransactionBuilder> {
    // TODO(atamari): Might have to split the transaction into 2 (if needed after testing)
    const {
      provider,
      whirlpool: address,
      quote: { maxTokenA, maxTokenB, liquidity, tickLowerIndex, tickUpperIndex },
    } = param;
    const ctx = WhirlpoolContext.withProvider(provider, this.dal.programId);
    const client = new WhirlpoolClient(ctx);

    const whirlpool = await this.getWhirlpool(address, true);

    const txBuilder = new TransactionBuilder(ctx.provider);

    const positionMintKeypair = Keypair.generate();
    const positionPda = getPositionPda(this.dal.programId, positionMintKeypair.publicKey);

    const positionTokenAccountAddress = await deriveATA(
      provider.wallet.publicKey,
      positionMintKeypair.publicKey
    );

    txBuilder
      .addInstruction(
        client
          .openPositionTx({
            funder: provider.wallet.publicKey,
            ownerKey: provider.wallet.publicKey,
            positionPda,
            positionMintAddress: positionMintKeypair.publicKey,
            positionTokenAccountAddress,
            whirlpoolKey: address,
            tickLowerIndex,
            tickUpperIndex,
          })
          .compressIx(false)
      )
      .addSigner(positionMintKeypair);

    const { address: tokenOwnerAccountA, ...tokenOwnerAccountAIx } = await resolveOrCreateATA(
      provider.connection,
      provider.wallet.publicKey,
      whirlpool.tokenMintA
    );
    txBuilder.addInstruction(tokenOwnerAccountAIx);

    const { address: tokenOwnerAccountB, ...tokenOwnerAccountBIx } = await resolveOrCreateATA(
      provider.connection,
      provider.wallet.publicKey,
      whirlpool.tokenMintB
    );
    txBuilder.addInstruction(tokenOwnerAccountBIx);

    const tickArrayLowerPda = TickUtil.deriveTickArrayPDA(
      tickLowerIndex,
      whirlpool.tickSpacing,
      address,
      this.dal.programId
    );
    const tickArrayUpperPda = TickUtil.deriveTickArrayPDA(
      tickUpperIndex,
      whirlpool.tickSpacing,
      address,
      this.dal.programId
    );

    const [tickArrayLower, tickArrayUpper] = await this.dal.listTickArrays(
      [tickArrayLowerPda.publicKey, tickArrayUpperPda.publicKey],
      true
    );

    if (tickArrayLower === null) {
      txBuilder.addInstruction(
        client
          .initTickArrayTx({
            whirlpool: address,
            tickArrayPda: tickArrayLowerPda,
            startTick: TickUtil.getStartTickIndex(tickLowerIndex, whirlpool.tickSpacing),
            funder: provider.wallet.publicKey,
          })
          .compressIx(false)
      );
    }

    if (
      tickArrayUpper === null &&
      !tickArrayLowerPda.publicKey.equals(tickArrayUpperPda.publicKey)
    ) {
      txBuilder.addInstruction(
        client
          .initTickArrayTx({
            whirlpool: address,
            tickArrayPda: tickArrayUpperPda,
            startTick: TickUtil.getStartTickIndex(tickUpperIndex, whirlpool.tickSpacing),
            funder: provider.wallet.publicKey,
          })
          .compressIx(false)
      );
    }

    // if (liquidity.gt(new u64(0))) {
    //   txBuilder.addInstruction(
    //     client
    //       .increaseLiquidityTx({
    //         liquidityAmount: liquidity,
    //         tokenMaxA: maxTokenA,
    //         tokenMaxB: maxTokenB,
    //         whirlpool: address,
    //         positionAuthority: provider.wallet.publicKey,
    //         position: address,
    //         positionTokenAccount: positionTokenAccountAddress,
    //         tokenOwnerAccountA,
    //         tokenOwnerAccountB,
    //         tokenVaultA: whirlpool.tokenVaultA,
    //         tokenVaultB: whirlpool.tokenVaultB,
    //         tickArrayLower: tickArrayLowerPda.publicKey,
    //         tickArrayUpper: tickArrayLowerPda.publicKey,
    //       })
    //       .compressIx(false)
    //   );
    // }

    return new MultiTransactionBuilder(provider, [txBuilder]);
  }

  /** 2. Close position tx **/
  // TODO check if position has liquidity first
  public async getClosePositionTransaction(
    param: ClosePositionTransactionParam
  ): Promise<MultiTransactionBuilder> {
    // 1. remove all liquidity
    // 2. close position
    const { provider, position: positionAddress, quote } = param;
    const { positionAuthority = provider.wallet.publicKey, receiver = provider.wallet.publicKey } =
      param;
    const ctx = WhirlpoolContext.withProvider(provider, this.dal.programId);
    const client = new WhirlpoolClient(ctx);

    const position = await this.getPosition(positionAddress, true);
    const whirlpool = await this.getWhirlpool(position.whirlpool, true);
    const [tickArrayLower, tickArrayUpper] = this.getTickArrayAddresses(
      position.whirlpool,
      whirlpool,
      position.tickLowerIndex,
      position.tickUpperIndex
    );
    invariant(!!tickArrayLower, "tickArrayLower cannot be undefined");
    invariant(!!tickArrayUpper, "tickArrayUpper cannot be undefined");

    const txBuilder = new TransactionBuilder(ctx.provider);

    const positionTokenAccount = await deriveATA(provider.wallet.publicKey, position.positionMint);

    const { address: tokenOwnerAccountA, ...tokenOwnerAccountAIx } = await resolveOrCreateATA(
      provider.connection,
      provider.wallet.publicKey,
      whirlpool.tokenMintA
    );
    txBuilder.addInstruction(tokenOwnerAccountAIx);

    const { address: tokenOwnerAccountB, ...tokenOwnerAccountBIx } = await resolveOrCreateATA(
      provider.connection,
      provider.wallet.publicKey,
      whirlpool.tokenMintB
    );
    txBuilder.addInstruction(tokenOwnerAccountBIx);

    txBuilder.addInstruction(
      client
        .decreaseLiquidityTx({
          liquidityAmount: position.liquidity,
          tokenMaxA: quote.minTokenA,
          tokenMaxB: quote.minTokenB,
          whirlpool: position.whirlpool,
          positionAuthority: provider.wallet.publicKey,
          position: positionAddress,
          positionTokenAccount,
          tokenOwnerAccountA,
          tokenOwnerAccountB,
          tokenVaultA: whirlpool.tokenVaultA,
          tokenVaultB: whirlpool.tokenVaultB,
          tickArrayLower,
          tickArrayUpper,
        })
        .compressIx(false)
    );

    txBuilder.addInstruction(
      client
        .closePositionTx({
          positionAuthority,
          receiver,
          positionTokenAccount,
          position: positionAddress,
          positionMint: position.positionMint,
        })
        .compressIx(false)
    );

    // TODO close position token account

    return new MultiTransactionBuilder(provider, [txBuilder]);
  }

  /** 3. Swap tx **/
  public async getSwapTransaction(param: SwapTransactionParam): Promise<MultiTransactionBuilder> {
    const {
      provider,
      whirlpool: whirlpoolAddress,
      quote: { sqrtPriceLimitX64, amountIn, amountOut, aToB, fixedOutput },
    } = param;
    const ctx = WhirlpoolContext.withProvider(provider, this.dal.programId);
    const client = new WhirlpoolClient(ctx);

    const whirlpool = await this.getWhirlpool(whirlpoolAddress);
    const txBuilder = new TransactionBuilder(ctx.provider);

    const { address: tokenOwnerAccountA, ...tokenOwnerAccountAIx } = await resolveOrCreateATA(
      provider.connection,
      provider.wallet.publicKey,
      whirlpool.tokenMintA
    );
    txBuilder.addInstruction(tokenOwnerAccountAIx);

    const { address: tokenOwnerAccountB, ...tokenOwnerAccountBIx } = await resolveOrCreateATA(
      provider.connection,
      provider.wallet.publicKey,
      whirlpool.tokenMintB
    );
    txBuilder.addInstruction(tokenOwnerAccountBIx);

    const nextTickArrayJump = aToB ? -TICK_ARRAY_SIZE : TICK_ARRAY_SIZE;

    const [tickArray0, tickArray1, tickArray2] = this.getTickArrayAddresses(
      whirlpoolAddress,
      whirlpool,
      whirlpool.tickCurrentIndex,
      whirlpool.tickCurrentIndex + nextTickArrayJump,
      whirlpool.tickCurrentIndex + 2 * nextTickArrayJump
    );
    invariant(!!tickArray0, "tickArray0 cannot be undefined");
    invariant(!!tickArray1, "tickArray1 cannot be undefined");
    invariant(!!tickArray2, "tickArray2 cannot be undefined");

    txBuilder.addInstruction(
      client
        .swapTx({
          amount: fixedOutput ? amountOut : amountIn,
          sqrtPriceLimit: sqrtPriceLimitX64, // TODO(atamari): Make sure this is not expected to be X64
          amountSpecifiedIsInput: !fixedOutput,
          aToB,
          whirlpool: whirlpoolAddress,
          tokenAuthority: provider.wallet.publicKey, // TODO(scuba)
          tokenOwnerAccountA,
          tokenVaultA: whirlpool.tokenVaultA,
          tokenOwnerAccountB,
          tokenVaultB: whirlpool.tokenVaultB,
          tickArray0,
          tickArray1,
          tickArray2,
        })
        .compressIx(false)
    );

    return new MultiTransactionBuilder(provider, [txBuilder]);
  }

  /*** Quotes (public) ***/

  /** 1. Open position quote **/
  public async getOpenPositionQuote(param: OpenPositionQuoteParam): Promise<OpenPositionQuote> {
    const {
      whirlpoolAddress,
      tokenMint,
      tokenAmount,
      priceLower,
      priceUpper,
      slippageTolerence = defaultSlippagePercentage,
      refresh,
    } = param;

    const whirlpool = await this.getWhirlpool(whirlpoolAddress, refresh);
    const [tokenAMintInfo, tokenBMintInfo] = await this.getTokenMintInfos(whirlpool);

    const tickLowerIndex = TickUtil.getNearestValidTickIndex(
      sqrtPriceX64ToTickIndex(toX64(priceLower.sqrt())),
      whirlpool.tickSpacing
    );
    const tickUpperIndex = TickUtil.getNearestValidTickIndex(
      sqrtPriceX64ToTickIndex(toX64(priceUpper.sqrt())),
      whirlpool.tickSpacing
    );

    const addLiquidityParams: InternalAddLiquidityQuoteParam = {
      whirlpool,
      tokenAMintInfo,
      tokenBMintInfo,
      tokenMint,
      tokenAmount,
      tickLowerIndex,
      tickUpperIndex,
      slippageTolerence,
    };

    const positionStatus = PositionUtil.getPositionStatus(
      whirlpool.tickCurrentIndex,
      tickLowerIndex,
      tickUpperIndex
    );

    let addLiquidityQuote: AddLiquidityQuote;
    switch (positionStatus) {
      case PositionStatus.BelowRange:
        addLiquidityQuote = getAddLiquidityQuoteWhenPositionIsBelowRange(addLiquidityParams);
        break;
      case PositionStatus.InRange:
        addLiquidityQuote = getAddLiquidityQuoteWhenPositionIsInRange(addLiquidityParams);
        break;
      case PositionStatus.AboveRange:
        addLiquidityQuote = getAddLiquidityQuoteWhenPositionIsAboveRange(addLiquidityParams);
        break;
    }

    return {
      ...addLiquidityQuote,
      tickLowerIndex,
      tickUpperIndex,
    };
  }

  /** 2. Close position quote **/
  public async getClosePositionQuote(param: ClosePositionQuoteParam): Promise<ClosePositionQuote> {
    const {
      position: positionAddress,
      refresh,
      slippageTolerence = defaultSlippagePercentage,
    } = param;
    const position = await this.getPosition(positionAddress, refresh);

    // Get remove liquidity quote for all of this position's liquidity
    return await new OrcaPosition(this.dal).getRemoveLiquidityQuote({
      address: positionAddress,
      liquidity: position.liquidity,
      refresh,
      slippageTolerence,
    });
  }

  /** 3. Swap quote **/
  public async getSwapQuote(param: SwapQuoteParam): Promise<SwapQuote> {
    const {
      whirlpool: whirlpoolAddress,
      tokenMint,
      tokenAmount,
      isOutput = false,
      slippageTolerance = defaultSlippagePercentage,
      refresh,
    } = param;

    const whirlpool = await this.getWhirlpool(whirlpoolAddress, refresh);

    const fetchTickArray = async (tickIndex: number) => {
      const tickArray = await this.dal.getTickArray(
        TickUtil.getAddressContainingTickIndex(
          tickIndex,
          whirlpool.tickSpacing,
          whirlpoolAddress,
          this.dal.programId
        ),
        refresh || false
      );
      invariant(!!tickArray, "tickArray is null");
      return tickArray;
    };

    const fetchTick = async (tickIndex: number) => {
      const tickArray = await fetchTickArray(tickIndex);
      return TickUtil.getTick(tickArray, tickIndex, whirlpool.tickSpacing);
    };

    const swapDirection =
      tokenMint === whirlpool.tokenMintA && isOutput ? SwapDirection.BtoA : SwapDirection.AtoB;
    const swapSimulator = new SwapSimulator({
      swapDirection,
      amountSpecified: isOutput ? AmountSpecified.Output : AmountSpecified.Input,
      feeRate: PoolUtil.getFeeRate(whirlpool),
      protocolFeeRate: PoolUtil.getProtocolFeeRate(whirlpool),
      slippageTolerance,
      fetchTickArray,
      fetchTick,
      getPrevInitializedTickIndex: async () => {
        let currentTickIndex = whirlpool.tickCurrentIndex;
        let prevInitializedTickIndex: number | undefined = undefined;

        while (!prevInitializedTickIndex) {
          const currentTickArray = await fetchTickArray(currentTickIndex);

          try {
            prevInitializedTickIndex = TickUtil.getPrevInitializedTickIndex(
              currentTickArray,
              currentTickIndex,
              whirlpool.tickSpacing
            );
          } catch (err) {
            if (err instanceof TickArrayOutOfBoundsError) {
              currentTickIndex = currentTickArray.startTickIndex - 1;
            } else {
              throw err;
            }
          }
        }

        return prevInitializedTickIndex;
      },
      getNextInitializedTickIndex: async () => {
        let currentTickIndex = whirlpool.tickCurrentIndex;
        let prevInitializedTickIndex: number | undefined = undefined;

        while (!prevInitializedTickIndex) {
          const currentTickArray = await fetchTickArray(currentTickIndex);

          try {
            prevInitializedTickIndex = TickUtil.getNextInitializedTickIndex(
              currentTickArray,
              currentTickIndex,
              whirlpool.tickSpacing
            );
          } catch (err) {
            if (err instanceof TickArrayOutOfBoundsError) {
              currentTickIndex = currentTickArray.startTickIndex + TICK_ARRAY_SIZE;
            } else {
              throw err;
            }
          }
        }

        return prevInitializedTickIndex;
      },
    });

    const { sqrtPriceLimitX64, amountIn, amountOut } = await swapSimulator.simulateSwap({
      amount: tokenAmount,
      currentSqrtPriceX64: whirlpool.sqrtPrice,
      currentTickIndex: whirlpool.tickCurrentIndex,
      currentTickArray: await fetchTickArray(whirlpool.tickCurrentIndex),
      currentLiquidity: whirlpool.liquidity,
    });

    return {
      sqrtPriceLimitX64,
      amountIn,
      amountOut,
      aToB: swapDirection === SwapDirection.AtoB,
      fixedOutput: isOutput,
    };
  }

  /*** Helpers (private) ***/
  private async getWhirlpool(address: PublicKey, refresh = false): Promise<WhirlpoolData> {
    const whirlpool = await this.dal.getPool(address, refresh);
    invariant(!!whirlpool, "OrcaWhirlpool - whirlpool does not exist");
    return whirlpool;
  }

  private async getPosition(address: PublicKey, refresh = false): Promise<PositionData> {
    const position = await this.dal.getPosition(address, refresh);
    invariant(!!position, "OrcaWhirlpool - position does not exist");
    return position;
  }

  private async getTokenMintInfos(whirlpool: WhirlpoolData): Promise<[MintInfo, MintInfo]> {
    const mintInfos = await this.dal.listMintInfos(
      [whirlpool.tokenMintA, whirlpool.tokenMintB],
      false
    );
    invariant(!!mintInfos && mintInfos.length === 2, "OrcaWhirlpool - unable to get mint infos");
    invariant(!!mintInfos[0] && !!mintInfos[1], "OrcaPosition - mint infos do not exist");
    return [mintInfos[0], mintInfos[1]];
  }

  private getTickArrayAddresses(
    whirlpool: PublicKey,
    whirlpoolData: WhirlpoolData,
    ...tickIndexes: number[]
  ): PublicKey[] {
    return tickIndexes.map((tickIndex) =>
      TickUtil.getAddressContainingTickIndex(
        tickIndex,
        whirlpoolData.tickSpacing,
        whirlpool,
        this.dal.programId
      )
    );
  }
}
