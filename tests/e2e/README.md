# Browser tests

The real app in Chromium (Playwright), on the real NYC street data, with a
stand-in base map (`style.json`, so no Mapbox token is needed) and, where
needed, a stand-in for the iPhone app's native side.

    npm ci
    npx playwright install chromium     # once
    npm run test:e2e                    # needs data/nyc (built by scripts/build_city.mjs)

They run in CI after the street data is built. Every test fails on any error
in the page's console.
