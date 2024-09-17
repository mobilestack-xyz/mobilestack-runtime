import { useHeaderHeight } from '@react-navigation/elements'
import React, { useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import {
  ActionSheetIOS,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  View,
} from 'react-native'
import { SafeAreaView } from 'react-native-safe-area-context'
import { ShouldStartLoadRequest } from 'react-native-webview/lib/WebViewTypes'
import { WebViewEvents } from 'src/analytics/Events'
import AppAnalytics from 'src/analytics/AppAnalytics'
import { openDeepLink } from 'src/app/actions'
import Touchable from 'src/components/Touchable'
import WebView, { WebViewRef } from 'src/components/WebView'
import BackChevron from 'src/icons/BackChevron'
import ForwardChevron from 'src/icons/ForwardChevron'
import Refresh from 'src/icons/Refresh'
import TripleDotVertical from 'src/icons/TripleDotVertical'
import { useDispatch } from 'src/redux/hooks'
import { getDynamicConfigParams } from 'src/statsig'
import { DynamicConfigs } from 'src/statsig/constants'
import { StatsigDynamicConfigs } from 'src/statsig/types'
import colors from 'src/styles/colors'
import { iconHitslop } from 'src/styles/variables'
import { navigateToURI } from 'src/utils/linking'
import { isWalletConnectDeepLink } from 'src/walletConnect/walletConnect'
import { WebViewAndroidBottomSheet } from 'src/webview/WebViewAndroidBottomSheet'
import { DEEPLINK_PREFIX } from 'src/config'

interface Props {
  uri: string
}

function InlineWebView({ uri }: Props) {
  const dispatch = useDispatch()
  const { t } = useTranslation()
  const headerHeight = useHeaderHeight()

  const disabledMediaPlaybackRequiresUserActionOrigins = getDynamicConfigParams(
    DynamicConfigs[StatsigDynamicConfigs.DAPP_WEBVIEW_CONFIG]
  ).disabledMediaPlaybackRequiresUserActionOrigins

  const webViewRef = useRef<WebViewRef>(null)
  const [canGoBack, setCanGoBack] = useState(false)
  const [canGoForward, setCanGoForward] = useState(false)
  const [showingBottomSheet, setShowingBottomSheet] = useState(false)
  const [currentUrl, setCurrentUrl] = useState('')

  const handleLoadRequest = (event: ShouldStartLoadRequest): boolean => {
    if (event.url.startsWith(`${DEEPLINK_PREFIX}://`) || isWalletConnectDeepLink(event.url)) {
      dispatch(openDeepLink(event.url))
      return false
    }
    return true
  }

  const handleRefresh = () => {
    webViewRef.current?.reload()
  }

  const handleGoForward = () => {
    webViewRef.current?.goForward()
  }

  const handleGoBack = () => {
    webViewRef.current?.goBack()
  }

  const openActionSheet = () => {
    Platform.OS === 'ios' ? openActionSheetiOS() : toggleBottomSheet()
    AppAnalytics.track(WebViewEvents.webview_more_options, { currentUrl })
  }

  // iOS Action sheet
  const openActionSheetiOS = () => {
    ActionSheetIOS.showActionSheetWithOptions(
      {
        options: [t('webView.openExternal'), t('dismiss')],
        cancelButtonIndex: 1,
      },
      (buttonIndex: number) => {
        switch (buttonIndex) {
          case 0:
            navigateToURI(currentUrl)
            AppAnalytics.track(WebViewEvents.webview_open_in_browser, { currentUrl })
            break
          default:
          case 1:
            break
        }
      }
    )
  }

  // Toggle for Android Bottom Sheet - passed to WebViewAndroidBottomSheet
  const toggleBottomSheet = () => setShowingBottomSheet((value: boolean) => !value)

  const { origin } = new URL(uri)
  const mediaPlaybackRequiresUserAction =
    !disabledMediaPlaybackRequiresUserActionOrigins.includes(origin)

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <KeyboardAvoidingView
        style={styles.keyboardView}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={headerHeight}
        testID="WebViewScreen/KeyboardAwareView"
      >
        <WebView
          ref={webViewRef}
          originWhitelist={['https://*', `${DEEPLINK_PREFIX}://*`]}
          onShouldStartLoadWithRequest={handleLoadRequest}
          source={{ uri }}
          startInLoadingState={true}
          renderLoading={() => <ActivityIndicator style={styles.loading} size="large" />}
          onNavigationStateChange={(navState) => {
            setCanGoBack(navState.canGoBack)
            setCanGoForward(navState.canGoForward)
            setCurrentUrl(navState.url)
          }}
          mediaPlaybackRequiresUserAction={mediaPlaybackRequiresUserAction}
          testID={'InlineWebView'}
        />
      </KeyboardAvoidingView>
      {Platform.OS === 'android' && (
        <WebViewAndroidBottomSheet
          currentUrl={currentUrl}
          isVisible={showingBottomSheet}
          onClose={() => setShowingBottomSheet(false)}
          toggleBottomSheet={toggleBottomSheet}
        />
      )}
      <View style={styles.navBar}>
        <Touchable
          onPress={handleGoBack}
          hitSlop={iconHitslop}
          disabled={!canGoBack}
          testID="WebViewScreen/GoBack"
        >
          <BackChevron color={canGoBack ? colors.black : colors.gray3} />
        </Touchable>
        <Touchable
          onPress={handleGoForward}
          hitSlop={iconHitslop}
          disabled={!canGoForward}
          testID="WebViewScreen/GoForward"
        >
          <ForwardChevron color={canGoForward ? colors.black : colors.gray3} />
        </Touchable>
        <Touchable onPress={handleRefresh} hitSlop={iconHitslop} testID="WebViewScreen/Refresh">
          <Refresh height={20} color={colors.black} />
        </Touchable>
        <Touchable
          onPress={openActionSheet}
          hitSlop={iconHitslop}
          testID="WebViewScreen/OpenBottomSheet"
        >
          <TripleDotVertical color={colors.black} />
        </Touchable>
      </View>
    </SafeAreaView>
  )
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  keyboardView: {
    flex: 1,
  },
  loading: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    top: 0,
  },
  navBar: {
    height: 52,
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 32,
    borderTopWidth: 1,
    borderColor: colors.gray2,
  },
})

export default InlineWebView
