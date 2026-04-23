# RAPT API Reference

## Authentication

- **Token endpoint:** `POST https://id.rapt.io/connect/token`
- **Content-Type:** `application/x-www-form-urlencoded`
- **Parameters:**
  - `client_id`: `rapt-user`
  - `grant_type`: `password`
  - `username`: RAPT account email
  - `password`: API Secret (created at My Account > API Secrets in RAPT portal; hashed and unrecoverable after creation)
- **Response:** `{"access_token": "...", "token_type": "Bearer", "expires_in": 3600}`
- **Token lifetime:** 3600 seconds (60 minutes)
- **JWT scopes:** `openid`, `profile`, `rapt-api`, `rapt-api.public`
- **JWT audience:** `rapt-api`
- **Usage:** `Authorization: Bearer {access_token}` header on all API calls
- **No refresh token** — must re-authenticate with credentials when token expires

## Swagger / OpenAPI

- **Swagger UI:** https://api.rapt.io/index.html
- **OpenAPI spec:** https://api.rapt.io/swagger/v1/swagger.json

## Rate Limiting

No explicit rate limit documented. Official docs warn: "All requests that you make to the Api are tracked" and abuse "affecting other customers may result in a warning or your access being revoked."

Community polling intervals:
- ha-rapt-package: 600s (10 min)
- rapt-mqtt-bridge: 900s (15 min)
- Safe minimum: 60s for polling, 300-600s recommended

## API Warnings (Official)

- "Access to the API is unsupported" — no KegLand tech support for API usage
- "The API (endpoints, parameters, response models etc.) is subject to change without notice"
- Misuse causing device damage voids warranty
- Extreme abuse can trigger permanent bans rendering devices non-functional

---

## All API Endpoints

### TemperatureControllers

| Method | Endpoint | Parameters |
|--------|----------|------------|
| GET | `/api/TemperatureControllers/GetTemperatureControllers` | none |
| GET | `/api/TemperatureControllers/GetTemperatureController` | `temperatureControllerId` (uuid) |
| POST | `/api/TemperatureControllers/SetTargetTemperature` | `temperatureControllerId` (uuid), `target` (double) |
| POST | `/api/TemperatureControllers/SetPIDEnabled` | `temperatureControllerId` (uuid), `state` (boolean) |
| POST | `/api/TemperatureControllers/SetPID` | `temperatureControllerId` (uuid), `p` (double), `i` (double), `d` (double) |
| GET | `/api/TemperatureControllers/GetTelemetry` | `temperatureControllerId` (uuid), `startDate`, `endDate`, `profileSessionId` (optional) |

### Hydrometers (RAPT Pill)

| Method | Endpoint | Parameters |
|--------|----------|------------|
| GET | `/api/Hydrometers/GetHydrometers` | none |
| GET | `/api/Hydrometers/GetHydrometer` | `hydrometerId` (uuid) |
| GET | `/api/Hydrometers/GetTelemetry` | `hydrometerId` (uuid), `startDate`, `endDate`, `profileSessionId` (optional) |

### FermentationChambers

| Method | Endpoint | Parameters |
|--------|----------|------------|
| GET | `/api/FermentationChambers/GetFermentationChambers` | none |
| GET | `/api/FermentationChambers/GetFermentationChamber` | `fermentationChamberId` (uuid) |
| POST | `/api/FermentationChambers/SetTargetTemperature` | `fermentationChamberId` (uuid), `target` (double) |
| POST | `/api/FermentationChambers/SetPIDEnabled` | `fermentationChamberId` (uuid), `state` (boolean) |
| POST | `/api/FermentationChambers/SetPID` | `fermentationChamberId` (uuid), `p`, `i`, `d` |
| GET | `/api/FermentationChambers/GetTelemetry` | `fermentationChamberId` (uuid), `startDate`, `endDate`, `profileSessionId` (optional) |

### BrewZillas

| Method | Endpoint | Parameters |
|--------|----------|------------|
| GET | `/api/BrewZillas/GetBrewZillas` | none |
| GET | `/api/BrewZillas/GetBrewZilla` | `brewZillaId` (uuid) |
| POST | `/api/BrewZillas/SetTargetTemperature` | `brewZillaId` (uuid), `target` (double) |
| POST | `/api/BrewZillas/SetHeatingEnabled` | `brewZillaId` (uuid), `state` (boolean) |
| POST | `/api/BrewZillas/SetHeatingUtilisation` | `brewZillaId` (uuid), `utilisation` (double) |
| POST | `/api/BrewZillas/SetPumpEnabled` | `brewZillaId` (uuid), `state` (boolean) |
| POST | `/api/BrewZillas/SetPumpUtilisation` | `brewZillaId` (uuid), `utilisation` (double) |
| POST | `/api/BrewZillas/SetPIDEnabled` | `brewZillaId` (uuid), `state` (boolean) |
| POST | `/api/BrewZillas/SetPID` | `brewZillaId` (uuid), `p`, `i`, `d` |
| GET | `/api/BrewZillas/GetTelemetry` | `brewZillaId` (uuid), `startDate`, `endDate`, `profileSessionId` (optional) |

### Stills

| Method | Endpoint | Parameters |
|--------|----------|------------|
| GET | `/api/Stills/GetStills` | none |
| GET | `/api/Stills/GetStill` | `stillId` (uuid) |
| POST | `/api/Stills/SetTargetTemperature` | `stillId` (uuid), `target` (double) |
| POST | `/api/Stills/SetHeatingEnabled` | `stillId` (uuid), `state` (boolean) |
| POST | `/api/Stills/SetHeatingUtilisation` | `stillId` (uuid), `utilisation` (double) |
| POST | `/api/Stills/SetPumpEnabled` | `stillId` (uuid), `state` (boolean) |
| POST | `/api/Stills/SetPumpUtilisation` | `stillId` (uuid), `utilisation` (double) |
| POST | `/api/Stills/SetPIDEnabled` | `stillId` (uuid), `state` (boolean) |
| POST | `/api/Stills/SetPID` | `stillId` (uuid), `p`, `i`, `d` |
| GET | `/api/Stills/GetTelemetry` | `stillId` (uuid), `startDate`, `endDate`, `profileSessionId` (optional) |

### CanFillers

| Method | Endpoint | Parameters |
|--------|----------|------------|
| GET | `/api/CanFillers/GetCanFillers` | none |
| GET | `/api/CanFillers/GetCanFiller` | `canFillerId` (uuid) |
| GET | `/api/CanFillers/GetTelemetry` | `canFillerId` (uuid), `startDate`, `endDate` |

### BondedDevices

| Method | Endpoint | Parameters |
|--------|----------|------------|
| GET | `/api/BondedDevices/GetBondedDevices` | none |
| GET | `/api/BondedDevices/GetBondedDevice` | `bondedDeviceId` (uuid) |
| GET | `/api/BondedDevices/GetTelemetry` | `bondedDeviceId` (uuid), `startDate`, `endDate` |

### ExternalDevices

| Method | Endpoint | Parameters |
|--------|----------|------------|
| GET | `/api/ExternalDevices/GetAll` | none |
| GET | `/api/ExternalDevices/Get` | `deviceId` (uuid) |
| GET | `/api/ExternalDevices/GetTelemetry` | `deviceId` (uuid), `startDate`, `endDate` |
| POST | `/api/ExternalDevices/Telemetry` | `deviceId` (uuid) + JSON body |

### Profiles

| Method | Endpoint | Parameters |
|--------|----------|------------|
| GET | `/api/Profiles/GetProfiles` | none |
| GET | `/api/Profiles/GetProfile` | `profileId` (uuid) |
| GET | `/api/ProfileTypes/GetAll` | none |
| GET | `/api/ProfileTypes/Get` | `id` (uuid) |

## Webhook Integration

RAPT portal supports custom webhooks that fire on telemetry updates. Template variables:
- All devices: `@device_id`, `@device_type`, `@device_name`, `@temperature`, `@rssi`, `@created_date`
- Hydrometer adds: `@gravity`, `@battery`
- FermentationChamber/TempController/BrewZilla add: `@target_temperature`
