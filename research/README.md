# Research

This directory contains research notes, API documentation, flow analysis, and backups supporting the RAPT2MQTT project.

---

## [rapt/](rapt/)

Research and documentation for the **RAPT ecosystem** (KegLand brewing devices). Covers the RAPT API authentication flow, all known API endpoints, the Temperature Controller data model, rate limiting guidance, and the full device ecosystem (Pill, Fermentation Chamber, BrewZilla, Still, Can Filler, Bonded Devices, and more). Also includes a survey of community projects that integrate with the RAPT API.

Key files:
- `README.md` -- Overview of RAPT integration in RAPT2MQTT
- `rapt-api.md` -- Complete API endpoint reference
- `rapt-devices.md` -- Full device ecosystem and schema documentation
- `community-projects.md` -- Community RAPT integration projects

## [tilt/](tilt/)

Research and documentation for the **TILT hydrometer** integration. Covers the TILT BLE iBeacon protocol, the 8-color UUID mapping, TiltPi Node-RED architecture (517 nodes reverse-engineered), the custom "Ian's Tasty MQTT Scrape" function, the enriched MQTT payload format, setup instructions, alternative bridges, and known limitations.

Key files:
- `README.md` -- Overview of TILT integration in RAPT2MQTT
- `tilt-ecosystem.md` -- Comprehensive TILT hardware and software ecosystem research
- `tiltpi-flow-analysis.md` -- Complete reverse-engineering of TiltPi v2.9.2 flows
- `tiltpi-nodered-flows.md` -- TiltPi connection details and Node-RED module inventory
- `tiltpi-flows-raw.json` -- Raw Node-RED flows export (248KB)
- `tiltpi-flows-backup-*.json` -- Timestamped backups of live TiltPi flows
- `tiltpi-nodes-raw.json` -- Installed Node-RED modules list
