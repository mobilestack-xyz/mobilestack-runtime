import HomeFeed from './usecases/HomeFeed'
import { quickOnboarding } from './utils/utils'

describe.skip('Home feed', () => {
  beforeAll(async () => {
    await quickOnboarding()
  })

  describe('when loaded', HomeFeed)
})
