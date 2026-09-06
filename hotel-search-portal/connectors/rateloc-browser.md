# RateLoc browser connector

This connector uses the authenticated RateLoc agent portal as a read-only supplier source.

## Portal
- Login URL: `https://www.rateloc.com/`
- Connector type: `browser`
- Supplier id: `rateloc`

## Login fields confirmed from the agent portal UI
- Username/email: `input[type="email"]` (fallback: visible text input)
- Password: `input[type="password"]`
- Login action: button containing `LOGIN`

## Search target
Use the RateLoc Dashboard `Accommodation` search form. The connector should return only rate/comparison data:

`Hotel → Room Category → View → Board → Cancellation → Price → Availability`

Do not expose hotel images or booking actions in normalized results.

## Configuration
Add RateLoc through the existing Admin → Sources screen with:

- Name: `RateLoc`
- Login URL: `https://www.rateloc.com/`
- Username: the authorized RateLoc agent email
- Password: entered through the portal UI; never commit it to GitHub
- Connector type: `browser`
- Enabled: `true`

The source password is encrypted by the existing application before storage.

## Important
This is read-only supplier automation. It must not bypass CAPTCHA, MFA, access controls, rate limits, or other security mechanisms. If RateLoc provides an official API, prefer the API connector over browser automation.
