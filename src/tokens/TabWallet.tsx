import React from 'react'
import { StyleSheet, Text, View } from 'react-native'
import { getNumberFormatSettings } from 'react-native-localize'
import AppAnalytics from 'src/analytics/AppAnalytics'
import { AssetsEvents } from 'src/analytics/Events'
import { hideWalletBalancesSelector } from 'src/app/selectors'
import { HideBalanceButton } from 'src/components/TokenBalance'
import { getLocalCurrencySymbol } from 'src/localCurrency/selectors'
import { navigate } from 'src/navigator/NavigationService'
import { Screens } from 'src/navigator/Screens'
import { useSelector } from 'src/redux/hooks'
import Colors from 'src/styles/colors'
import { typeScale } from 'src/styles/fonts'
import { useTotalTokenBalance } from 'src/tokens/hooks'
import { sortedTokensWithBalanceOrShowZeroBalanceSelector } from 'src/tokens/selectors'
import { TokenBalanceItem } from 'src/tokens/TokenBalanceItem'
import { getTokenAnalyticsProps } from 'src/tokens/utils'
import { NetworkId } from 'src/transactions/types'

function TabWallet() {
  const hideWalletBalances = useSelector(hideWalletBalancesSelector)
  const localCurrencySymbol = useSelector(getLocalCurrencySymbol)
  const { decimalSeparator } = getNumberFormatSettings()

  const tokens = useSelector((state) =>
    sortedTokensWithBalanceOrShowZeroBalanceSelector(state, [
      NetworkId['celo-mainnet'],
      NetworkId['celo-alfajores'],
    ])
  )
  const totalTokenBalanceLocal = useTotalTokenBalance()
  const balanceDisplay = hideWalletBalances
    ? `XX${decimalSeparator}XX`
    : totalTokenBalanceLocal?.toFormat(2)
  return (
    <View>
      <View style={styles.row}>
        <Text style={styles.totalBalance} testID={'TotalTokenBalance'}>
          {!hideWalletBalances && localCurrencySymbol}
          {balanceDisplay}
        </Text>
        <HideBalanceButton hideBalance={hideWalletBalances} />
      </View>
      {tokens.map((token) => (
        <TokenBalanceItem
          token={token}
          onPress={() => {
            navigate(Screens.TokenDetails, { tokenId: token.tokenId })
            AppAnalytics.track(AssetsEvents.tap_asset, {
              ...getTokenAnalyticsProps(token),
              title: token.symbol,
              description: token.name,
              assetType: 'token',
            })
          }}
          hideBalances={hideWalletBalances}
        />
      ))}
    </View>
  )
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  totalBalance: {
    ...typeScale.titleLarge,
    color: Colors.black,
  },
})

export default TabWallet
