import { CeloTransactionObject, Contract, toTransactionObject } from '@celo/connect'
import { ContractKit } from '@celo/contractkit'
import BigNumber from 'bignumber.js'
import { call, put, select, spawn, take, takeLeading } from 'redux-saga/effects'
import { showErrorOrFallback } from 'src/alert/actions'
import { CeloExchangeEvents, SendEvents } from 'src/analytics/Events'
import ValoraAnalytics from 'src/analytics/ValoraAnalytics'
import { ErrorMessages } from 'src/app/ErrorMessages'
import { calculateFee, currencyToFeeCurrency, FeeInfo } from 'src/fees/saga'
import { transferGoldTokenLegacy } from 'src/goldToken/actions'
import { encryptComment } from 'src/identity/commentEncryption'
import { e164NumberToAddressSelector } from 'src/identity/selectors'
import { navigateBack, navigateHome } from 'src/navigator/NavigationService'
import { completePaymentRequest } from 'src/paymentRequest/actions'
import { handleBarcode, shareSVGImage } from 'src/qrcode/utils'
import { RecipientInfo } from 'src/recipients/recipient'
import { recipientInfoSelector } from 'src/recipients/reducer'
import {
  Actions,
  HandleBarcodeDetectedAction,
  SendPaymentAction,
  SendPaymentActionLegacy,
  sendPaymentFailure,
  sendPaymentSuccess,
  ShareQRCodeAction,
} from 'src/send/actions'
import { SentryTransactionHub } from 'src/sentry/SentryTransactionHub'
import { SentryTransaction } from 'src/sentry/SentryTransactions'
import { transferStableTokenLegacy } from 'src/stableToken/actions'
import {
  BasicTokenTransfer,
  createTokenTransferTransaction,
  getCurrencyAddress,
  getERC20TokenContract,
  getStableTokenContract,
  getTokenInfo,
  tokenAmountInSmallestUnit,
} from 'src/tokens/saga'
import { tokensByCurrencySelector } from 'src/tokens/selectors'
import { TokenBalance } from 'src/tokens/slice'
import { addStandbyTransaction } from 'src/transactions/actions'
import { sendAndMonitorTransaction } from 'src/transactions/saga'
import {
  newTransactionContext,
  TokenTransactionTypeV2,
  TransactionContext,
  TransactionStatus,
} from 'src/transactions/types'
import { Currency } from 'src/utils/currencies'
import Logger from 'src/utils/Logger'
import { safely } from 'src/utils/safely'
import { getContractKit } from 'src/web3/contracts'
import { getRegisterDekTxGas } from 'src/web3/dataEncryptionKey'
import { getConnectedUnlockedAccount } from 'src/web3/saga'
import { currentAccountSelector } from 'src/web3/selectors'
import { estimateGas } from 'src/web3/utils'
import * as utf8 from 'utf8'

const TAG = 'send/saga'

// All observed cUSD and CELO transfers take less than 200000 gas.
export const STATIC_SEND_TOKEN_GAS_ESTIMATE = 200000

export async function getSendTxGas(
  account: string,
  currency: Currency,
  params: BasicTokenTransfer,
  useStatic: boolean = true
): Promise<BigNumber> {
  if (useStatic) {
    Logger.debug(`${TAG}/getSendTxGas`, `Using static gas of ${STATIC_SEND_TOKEN_GAS_ESTIMATE}`)
    return new BigNumber(STATIC_SEND_TOKEN_GAS_ESTIMATE)
  }

  try {
    Logger.debug(`${TAG}/getSendTxGas`, 'Getting gas estimate for send tx')
    const currencyAddress = await getCurrencyAddress(currency)
    const tx = await createTokenTransferTransaction(currencyAddress, params)
    const txParams = {
      from: account,
      feeCurrency: currency === Currency.Celo ? undefined : currencyAddress,
    }
    const gas = await estimateGas(tx.txo, txParams)
    Logger.debug(`${TAG}/getSendTxGas`, `Estimated gas of ${gas.toString()}`)
    return gas
  } catch (error) {
    Logger.error(`${TAG}/getSendTxGas`, 'Failed to get send tx gas', error)
    throw error
  }
}

export async function getSendFee(
  account: string,
  currency: Currency,
  params: BasicTokenTransfer,
  includeDekFee: boolean = false,
  balance: string
) {
  try {
    if (new BigNumber(params.amount).isGreaterThan(new BigNumber(balance))) {
      throw new Error(ErrorMessages.INSUFFICIENT_BALANCE)
    }

    let gas = await getSendTxGas(account, currency, params)
    if (includeDekFee) {
      const dekGas = await getRegisterDekTxGas(account, currency)
      gas = gas.plus(dekGas)
    }

    return calculateFee(gas, await currencyToFeeCurrency(currency))
  } catch (error) {
    throw error
  }
}

export function* watchQrCodeDetections() {
  while (true) {
    const action: HandleBarcodeDetectedAction = yield take(Actions.BARCODE_DETECTED)
    Logger.debug(TAG, 'Barcode detected in watcher')
    const recipientInfo: RecipientInfo = yield select(recipientInfoSelector)

    const e164NumberToAddress = yield select(e164NumberToAddressSelector)
    const isOutgoingPaymentRequest = action.isOutgoingPaymentRequest
    let secureSendTxData
    let requesterAddress

    if (action.scanIsForSecureSend) {
      secureSendTxData = action.transactionData
      requesterAddress = action.requesterAddress
    }

    try {
      yield call(
        handleBarcode,
        action.data,
        e164NumberToAddress,
        recipientInfo,
        secureSendTxData,
        isOutgoingPaymentRequest,
        requesterAddress
      )
    } catch (error) {
      Logger.error(TAG, 'Error handling the barcode', error)
    }
  }
}

export function* watchQrCodeShare() {
  while (true) {
    const action: ShareQRCodeAction = yield take(Actions.QRCODE_SHARE)
    try {
      const result = yield call(shareSVGImage, action.qrCodeSvg)
      // Note: when user cancels the share sheet, result contains {"dismissedAction":true}
      Logger.info(TAG, 'Share done', result)
    } catch (error) {
      Logger.error(TAG, 'Error sharing qr code', error)
    }
  }
}

function* sendPaymentLegacy(
  recipientAddress: string,
  amount: BigNumber,
  comment: string,
  currency: Currency,
  feeInfo?: FeeInfo
) {
  try {
    ValoraAnalytics.track(SendEvents.send_tx_start)

    const ownAddress: string = yield select(currentAccountSelector)
    const encryptedComment = yield call(encryptComment, comment, recipientAddress, ownAddress, true)

    const context = newTransactionContext(TAG, 'Send payment')
    switch (currency) {
      case Currency.Celo: {
        yield put(
          transferGoldTokenLegacy({
            recipientAddress,
            amount: amount.toString(),
            currency,
            comment: encryptedComment,
            feeInfo,
            context,
          })
        )
        break
      }
      case Currency.Dollar:
      case Currency.Euro: {
        yield put(
          transferStableTokenLegacy({
            recipientAddress,
            amount: amount.toString(),
            currency,
            comment: encryptedComment,
            feeInfo,
            context,
          })
        )
        break
      }
      default: {
        throw new Error(`Sending currency ${currency} not yet supported`)
      }
    }
    ValoraAnalytics.track(SendEvents.send_tx_complete, {
      txId: context.id,
      recipientAddress,
      amount: amount.toString(),
      tokenAddress: currency,
      usdAmount: '',
    })
  } catch (error) {
    Logger.debug(`${TAG}/sendPaymentLegacy`, 'Could not send payment', error.message)
    ValoraAnalytics.track(SendEvents.send_tx_error, { error: error.message })
    throw error
  }
}

export function* buildSendTx(
  tokenAddress: string,
  amount: BigNumber,
  recipientAddress: string,
  comment: string
) {
  const contract: Contract = yield call(getERC20TokenContract, tokenAddress)
  const coreContract: Contract = yield call(getStableTokenContract, tokenAddress)

  const tokenInfo: TokenBalance | undefined = yield call(getTokenInfo, tokenAddress)
  const convertedAmount: string = yield call(tokenAmountInSmallestUnit, amount, tokenAddress)

  const kit: ContractKit = yield call(getContractKit)
  return toTransactionObject(
    kit.connection,
    tokenInfo?.isCoreToken && tokenInfo.symbol !== 'CELO'
      ? coreContract.methods.transferWithComment(
          recipientAddress,
          convertedAmount,
          utf8.encode(comment)
        )
      : contract.methods.transfer(recipientAddress, convertedAmount)
  )
}

/**
 * Sends a payment to an address with an encrypted comment
 *
 * @param context the transaction context
 * @param recipientAddress the address to send the payment to
 * @param amount the crypto amount to send
 * @param tokenAddress the crypto token address
 * @param comment the comment on the transaction
 * @param feeInfo an object containing the fee information
 */
export function* buildAndSendPayment(
  context: TransactionContext,
  recipientAddress: string,
  amount: BigNumber,
  tokenAddress: string,
  comment: string,
  feeInfo: FeeInfo
) {
  const userAddress: string = yield call(getConnectedUnlockedAccount)

  const encryptedComment: string = yield call(
    encryptComment,
    comment,
    recipientAddress,
    userAddress,
    true
  )

  Logger.debug(
    TAG,
    'Transferring token',
    context.description ?? 'No description',
    context.id,
    tokenAddress,
    amount,
    feeInfo
  )

  yield put(
    addStandbyTransaction({
      context,
      type: TokenTransactionTypeV2.Sent,
      comment,
      status: TransactionStatus.Pending,
      value: amount.negated().toString(),
      tokenAddress,
      timestamp: Math.floor(Date.now() / 1000),
      address: recipientAddress,
    })
  )

  const tx: CeloTransactionObject<boolean> = yield call(
    buildSendTx,
    tokenAddress,
    amount,
    recipientAddress,
    encryptedComment
  )

  const { receipt, error } = yield call(
    sendAndMonitorTransaction,
    tx,
    userAddress,
    context,
    feeInfo.feeCurrency,
    feeInfo.gas ? Number(feeInfo.gas) : undefined,
    feeInfo.gasPrice
  )

  return { receipt, error }
}

/**
 * Sends a payment to an address with an encrypted comment and gives profile
 * access to the recipient
 *
 * @param recipientAddress the address to send the payment to
 * @param amount the crypto amount to send
 * @param usdAmount the amount in usd (nullable, used only for analytics)
 * @param tokenAddress the crypto token address
 * @param comment the comment on the transaction
 * @param feeInfo an object containing the fee information
 */
function* sendPayment(
  recipientAddress: string,
  amount: BigNumber,
  usdAmount: BigNumber | null,
  tokenAddress: string,
  comment: string,
  feeInfo: FeeInfo
) {
  const context = newTransactionContext(TAG, 'Send payment')

  try {
    ValoraAnalytics.track(SendEvents.send_tx_start)

    yield call(
      buildAndSendPayment,
      context,
      recipientAddress,
      amount,
      tokenAddress,
      comment,
      feeInfo
    )

    ValoraAnalytics.track(SendEvents.send_tx_complete, {
      txId: context.id,
      recipientAddress,
      amount: amount.toString(),
      usdAmount: usdAmount?.toString(),
      tokenAddress,
    })
  } catch (error) {
    Logger.error(`${TAG}/sendPayment`, 'Could not make token transfer', error.message)
    ValoraAnalytics.track(SendEvents.send_tx_error, { error: error.message })
    yield put(showErrorOrFallback(error, ErrorMessages.TRANSACTION_FAILED))
    // TODO: Uncomment this when the transaction feed supports multiple tokens.
    // yield put(removeStandbyTransaction(context.id))
  }
}

export function* sendPaymentSagaLegacy({
  amount,
  currency,
  comment,
  recipientAddress,
  feeInfo,
  firebasePendingRequestUid,
  fromModal,
}: SendPaymentActionLegacy) {
  try {
    yield call(getConnectedUnlockedAccount)
    SentryTransactionHub.startTransaction(SentryTransaction.send_payment_legacy)
    const tokenByCurrency: Record<Currency, TokenBalance | undefined> = yield select(
      tokensByCurrencySelector
    )
    const tokenInfo = tokenByCurrency[currency]
    if (!tokenInfo) {
      throw new Error(`No token info found for ${currency}`)
    }

    if (recipientAddress) {
      yield call(sendPaymentLegacy, recipientAddress, amount, comment, currency, feeInfo)
    } else {
      throw new Error('No address found on recipient')
    }

    if (firebasePendingRequestUid) {
      yield put(completePaymentRequest(firebasePendingRequestUid))
    }

    if (fromModal) {
      navigateBack()
    } else {
      navigateHome()
    }

    yield put(sendPaymentSuccess(amount))
    SentryTransactionHub.finishTransaction(SentryTransaction.send_payment_legacy)
  } catch (e) {
    yield put(showErrorOrFallback(e, ErrorMessages.SEND_PAYMENT_FAILED))
    yield put(sendPaymentFailure())
  }
}

export function* watchSendPaymentLegacy() {
  yield takeLeading(Actions.SEND_PAYMENT_LEGACY, safely(sendPaymentSagaLegacy))
}

export function* sendPaymentSaga({
  amount,
  tokenAddress,
  usdAmount,
  comment,
  recipient,
  feeInfo,
  fromModal,
}: SendPaymentAction) {
  try {
    yield call(getConnectedUnlockedAccount)
    SentryTransactionHub.startTransaction(SentryTransaction.send_payment)
    const tokenInfo: TokenBalance | undefined = yield call(getTokenInfo, tokenAddress)
    if (recipient.address) {
      yield call(sendPayment, recipient.address, amount, usdAmount, tokenAddress, comment, feeInfo)
      if (tokenInfo?.symbol === 'CELO') {
        ValoraAnalytics.track(CeloExchangeEvents.celo_withdraw_completed, {
          amount: amount.toString(),
        })
      }
    } else {
      throw new Error('No address found on recipient')
    }

    if (fromModal) {
      navigateBack()
    } else {
      navigateHome()
    }

    yield put(sendPaymentSuccess(amount))
    SentryTransactionHub.finishTransaction(SentryTransaction.send_payment)
  } catch (e) {
    yield put(showErrorOrFallback(e, ErrorMessages.SEND_PAYMENT_FAILED))
    yield put(sendPaymentFailure())
  }
}

export function* watchSendPayment() {
  yield takeLeading(Actions.SEND_PAYMENT, safely(sendPaymentSaga))
}

export function* sendSaga() {
  yield spawn(watchQrCodeDetections)
  yield spawn(watchQrCodeShare)
  yield spawn(watchSendPayment)
  yield spawn(watchSendPaymentLegacy)
}
