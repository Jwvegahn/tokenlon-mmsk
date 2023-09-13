import { memoize } from 'lodash'
import { Quoter } from '../request/marketMaker'
import { updaterStack } from '../worker'
import { Protocol, QueryInterface } from '../types'
import { validateNewOrderRequest, validateRequest } from '../validations'
import { ValidationError } from './errors'
import { addQuoteIdPrefix, constructQuoteResponse, preprocessQuote } from '../quoting'
import { assetDataUtils } from '0x-v2-order-utils'
import { buildSignedOrder as buildRFQV1SignedOrder } from '../signer/rfqv1'
import { buildSignedOrder as buildRFQV2SignedOrder } from '../signer/rfqv2'
import { buildSignedOrder } from '../signer/pmmv5'
import { buildSignedOrder as buildAMMV1Order } from '../signer/ammv1'
import { buildSignedOrder as buildAMMV2Order } from '../signer/ammv2'
import { FEE_RECIPIENT_ADDRESS } from '../constants'
import {
  BigNumber,
  fromUnitToDecimalBN,
  toBN,
  getSupportedTokens,
  getTokenByAddress,
  getWethAddrIfIsEth,
  getTimestamp,
} from '../utils'
import { ExtendedZXOrder } from '../signer/types'

type NumberOrString = number | string

export interface Order {
  // quoteId is from market maker backend quoter.
  quoteId: string | number
  // protocol represents the order type as enum, [PMMV4, PMMV5, AMMV1, RFQV1, AMMV2].
  protocol: Protocol

  // Common fields
  makerAddress: string
  makerAssetAmount: string | BigNumber
  makerAssetAddress: string
  takerAddress: string
  takerAssetAmount: string | BigNumber
  takerAssetAddress: string
  expirationTimeSeconds: BigNumber | string
  // feeFactor is tokenlon protocol field, works like BPS, should <= 10000.
  feeFactor: number
  // salt represents the uniqueness of order, is to prevent replay attack.
  salt?: BigNumber | string

  // 0x protocol specific fields
  makerAssetData: string
  takerAssetData: string
  senderAddress: string
  // For PMMV5, we use this field as receiver address (user address).
  feeRecipientAddress: string
  exchangeAddress: string

  // makerFee and takerFee are not used, but keep to make 0x order signature.
  makerFee: BigNumber | string
  takerFee: BigNumber | string

  // PMM/RFQ market maker signature
  makerWalletSignature?: string

  // Extra data
  payload?: string
}

export interface Response {
  rate: NumberOrString
  minAmount: NumberOrString
  maxAmount: NumberOrString
  order?: Order
}

// use smallest decimals from [USDT/USDC: 6, BTC: 8, ETH: 18]
const TRUNCATE_PRECISION = 6

const findSuitablePrecision = (decimals: number): number => {
  return decimals < 8 ? TRUNCATE_PRECISION : 8
}

// request getPrice API from market maker backend
async function requestMarketMaker(quoter: Quoter, query: QueryInterface) {
  // request to market maker backend
  const { side } = query
  const priceResult = await quoter.getPrice(query as any)
  console.log('got result from market maker', { query, priceResult })
  const rateBody = {
    ...constructQuoteResponse(priceResult, side),
    quoteId: addQuoteIdPrefix(priceResult.quoteId),
    payload: priceResult.payload,
  }
  return rateBody
}

function extractAssetAmounts(
  makerToken,
  takerToken,
  side,
  rate: number | string,
  amountBN: BigNumber
): {
  makerAssetAmount: BigNumber
  takerAssetAmount: BigNumber
} {
  let makerAssetAmount, takerAssetAmount
  if (side === 'BUY') {
    makerAssetAmount = fromUnitToDecimalBN(
      amountBN.toFixed(makerToken.precision),
      makerToken.decimal
    )
    takerAssetAmount = fromUnitToDecimalBN(
      amountBN.dividedBy(rate.toString()).toFixed(findSuitablePrecision(takerToken.decimal)),
      takerToken.decimal
    )
  } else {
    makerAssetAmount = fromUnitToDecimalBN(
      amountBN.times(rate.toString()).toFixed(findSuitablePrecision(makerToken.decimal)),
      makerToken.decimal
    )
    takerAssetAmount = fromUnitToDecimalBN(
      amountBN.toFixed(takerToken.precision),
      takerToken.decimal
    )
  }
  return { makerAssetAmount, takerAssetAmount }
}

function getOrderAndFeeFactor(
  query: QueryInterface,
  rate,
  tokenList,
  tokenConfigs,
  config
): ExtendedZXOrder {
  const { side, amount, feefactor } = query
  const baseToken = getTokenByAddress(tokenList, query.baseAddress)
  const quoteToken = getTokenByAddress(tokenList, query.quoteAddress)
  const makerToken = side === 'BUY' ? baseToken : quoteToken
  const takerToken = side === 'BUY' ? quoteToken : baseToken
  const foundTokenConfig = tokenConfigs.find((t) => t.symbol === makerToken.symbol)

  let fFactor: number = Number(config.feeFactor) || 10
  if (foundTokenConfig?.feeFactor) {
    // console.log('set fee factor from token config', { factor: foundTokenConfig.feeFactor })
    fFactor = foundTokenConfig.feeFactor
  }
  if (feefactor && !Number.isNaN(+feefactor) && +feefactor >= 0) {
    // console.log('set fee factor from query string', { queryFeeFactor })
    fFactor = +feefactor
  }

  // 针对用户买，对于做市商是提供卖单
  // 用户用quote 买base，做市商要构建卖base 换quote的order
  // 因此 order makerToken 是 base，takerToken 是 quote
  // 例如：用户 ETH -> DAI
  // rate 200
  // side BUY
  const { makerAssetAmount, takerAssetAmount } = extractAssetAmounts(
    makerToken,
    takerToken,
    side,
    rate,
    toBN(amount)
  )

  // ETH -> WETH
  const makerAssetAddress: string = getWethAddrIfIsEth(
    makerToken.contractAddress,
    config.wethContractAddress
  )
  // ETH -> WETH
  let takerAssetAddress: string = getWethAddrIfIsEth(
    takerToken.contractAddress,
    config.wethContractAddress
  )
  if (Protocol.RFQV2 === query.protocol) {
    takerAssetAddress = takerToken.contractAddress
  }
  return {
    protocol: query.protocol,
    quoteId: query.uniqId,
    makerAddress: config.mmProxyContractAddress.toLowerCase(),
    makerAssetAmount,
    makerAssetAddress: makerAssetAddress,
    makerAssetData: assetDataUtils.encodeERC20AssetData(makerAssetAddress),
    makerFee: toBN(0),

    takerAddress: config.userProxyContractAddress as string,
    takerAssetAmount,
    takerAssetAddress: takerAssetAddress,
    takerAssetData: assetDataUtils.encodeERC20AssetData(takerAssetAddress),
    takerFee: toBN(0),

    senderAddress: config.tokenlonExchangeContractAddress.toLowerCase(),
    feeRecipientAddress: FEE_RECIPIENT_ADDRESS.toLowerCase(),
    expirationTimeSeconds: toBN(getTimestamp() + +config.orderExpirationSeconds),
    exchangeAddress: config.exchangeContractAddress.toLowerCase() as string,

    feeFactor: fFactor,
  }
}

const _getBaseTokenByAddress = (baseTokenAddr, tokenList) => {
  return tokenList.find((token) => token.contractAddress.toLowerCase() === baseTokenAddr)
}

const getBaseTokenByAddress = memoize(_getBaseTokenByAddress)

export const newOrder = async (ctx): Promise<Response> => {
  const { quoter, signer, chainID, walletType, signingUrl, permitType } = ctx
  const req: QueryInterface = {
    protocol: Protocol.PMMV5, // by default is v2 protocol
    ...ctx.query, // overwrite from request
  }

  try {
    const query = preprocessQuote(req)
    let errMsg = validateRequest(query)
    if (errMsg) throw new ValidationError(errMsg)
    const { amount, uniqId, userAddr, protocol } = query
    errMsg = validateNewOrderRequest(amount, uniqId, userAddr)
    if (errMsg) throw new ValidationError(errMsg)

    const rateBody = await requestMarketMaker(quoter, query)
    const config = updaterStack.markerMakerConfigUpdater.cacheResult
    const tokenConfigs = updaterStack.tokenConfigsFromImtokenUpdater.cacheResult
    const tokenList = getSupportedTokens()

    const { rate, minAmount, maxAmount, quoteId, salt } = rateBody
    const order = getOrderAndFeeFactor(query, rate, tokenList, tokenConfigs, config)
    const resp: Response = {
      rate,
      minAmount,
      maxAmount,
    }
    switch (protocol) {
      case Protocol.AMMV1:
        // directly use system token config
        {
          const baseTokenAddr = query.baseAddress
          const baseToken = getBaseTokenByAddress(baseTokenAddr.toLowerCase(), tokenList)
          resp.minAmount = baseToken.minTradeAmount
          resp.maxAmount = baseToken.maxTradeAmount
        }
        resp.order = buildAMMV1Order(order, rateBody.makerAddress, config.wethContractAddress)
        break
      case Protocol.AMMV2:
        {
          const baseTokenAddr = query.baseAddress
          const baseToken = getBaseTokenByAddress(baseTokenAddr.toLowerCase(), tokenList)
          resp.minAmount = baseToken.minTradeAmount
          resp.maxAmount = baseToken.maxTradeAmount
        }
        resp.order = buildAMMV2Order(
          order,
          rateBody.payload,
          rateBody.makerAddress,
          config.wethContractAddress
        )
        break
      case Protocol.PMMV5:
        resp.order = await buildSignedOrder(
          signer,
          order,
          userAddr.toLowerCase(),
          chainID,
          config.addressBookV5.PMM,
          {
            signingUrl,
            salt,
          }
        )
        break
      case Protocol.RFQV1:
        resp.order = await buildRFQV1SignedOrder(
          signer,
          order,
          userAddr.toLowerCase(),
          chainID,
          config.addressBookV5.RFQ,
          walletType,
          {
            signingUrl,
            salt,
          }
        )
        break
      case Protocol.RFQV2:
        resp.order = await buildRFQV2SignedOrder(
          signer,
          order,
          userAddr.toLowerCase(),
          chainID,
          config.addressBookV5.RFQV2,
          walletType,
          permitType,
          {
            signingUrl,
            salt,
          }
        )
        break
      default:
        console.log(`unknown protocol ${protocol}`)
        throw new Error('Unrecognized protocol: ' + protocol)
    }

    resp.order.quoteId = quoteId
    resp.order.protocol = protocol

    ctx.body = {
      result: true,
      exchangeable: true,
      ...resp,
    }
    return resp
  } catch (e) {
    console.error(e.stack)
    ctx.body = {
      result: false,
      exchangeable: false,
      message: e.message,
    }
    return e.message
  }
}
