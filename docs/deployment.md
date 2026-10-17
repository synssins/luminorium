# Deployment

Luminorium is installed as a Home Assistant add-on from this repository
(`https://github.com/synssins/luminorium`, public). On the house HA its slug is
`c685dad4_luminorium`.

## Add-on files

| File | What |
|---|---|
| `repository.yaml` | Makes the repository an add-on repository |
| `luminorium_addon/config.yaml` | Add-on manifest: version, slug `luminorium`, `arch: [amd64]`, Ingress on 8199, `homeassistant_api`, `hassio_api`, `services: [mqtt:need]`, `host_network: true`, `addon_config` map, options |
| `luminorium_addon/build.yaml` | `build_from`: `ghcr.io/home-assistant/amd64-base-debian:trixie-2026.10.0` |
| `luminorium_addon/Dockerfile` | Python 3.13 from Debian in `/opt/venv`, requirements, the `luminorium` package; `CMD /run.sh` |
| `luminorium_addon/run.sh` | `exec python3 -m luminorium` |
| `luminorium_addon/DOCS.md` | Shown in HA's add-on page |
| `luminorium_addon/CHANGELOG.md` | Shown when updating |

## Choices and why

- **Debian base, not Alpine:** `opencv-python-headless` (phase 5 mapping) has no musllinux wheels.
- **Image size with OpenCV (0.1.0-dev.4):** the new wheels for Python 3.13 on amd64 are 78 MB to
  download and **217 MB installed** (opencv-python-headless 5.0.0.93: 160 MB, numpy 2.5.4: 56 MB,
  websockets 17.2: 1 MB), measured from the manylinux wheels on 2026-10-16. Docker isn't on the
  development PC, so the built image itself is measured on the HA host after the first install
  of this version (`docker image ls` there, or the Supervisor's add-on info). Expected about
  300 MB in all.
- **websockets** is required: without it uvicorn answers the phone's capture websocket with 404.
- **amd64 only:** the HA host is generic x86-64. Add aarch64 when there's a reason.
- **Host networking** (since 0.2.0): the WiZ, WLED and Govee drivers use UDP on the LAN, and
  Govee devices answer to port 4002 of the sender. The web server listens on the host's 8199 but
  refuses anything but the ingress proxy (`172.30.32.2`) and localhost; 8199 avoids
  Zigbee2MQTT's 8099 on the host. With host networking the add-on hostname `core-zwave-js` may not
  resolve, so the Z-Wave driver falls back to the add-on's IP ([drivers.md](drivers.md)).
- **`services: [mqtt:need]`:** the Supervisor gives the add-on its own Mosquitto user (read from
  `services/mqtt`), so no MQTT credentials are configured by hand. The add-on won't start
  without an MQTT service.
- **Built on the HA host:** there is no prebuilt image (`image:` is not set), so the Supervisor
  builds the Dockerfile on install and update.

## Rules learned from Bifrost

- **Every build gets a new `version`** in `config.yaml` (and `luminorium/__init__.py`). HA reuses a
  cached image when the version is unchanged.
- **Never put a digest in `build_from`.** The Supervisor then silently builds from its own base
  image instead. Pin a dated tag.
- Back up before replacing anything on the HA host.

## Install

1. In HA: Settings → Add-ons → Add-on store → ⋮ → Repositories → add
   `https://github.com/synssins/luminorium`. (Or through the Supervisor API:
   `POST /store/repositories {"repository": "<url>"}`.)
2. Install **Luminorium**. Before the first start, turn on the `read_only` option to look around
   without touching any light.
3. Start it and open it from the sidebar.

## Updating

Push a commit with a new `version`, then in HA: Add-on store → ⋮ → Check for updates (or
`POST /store/reload`), then update the add-on (`POST /store/addons/<slug>/update`). The image is
rebuilt on the host.

## Options

| Option | Default | What |
|---|---|---|
| `log_level` | `info` | `debug`, `info`, `warning`, `error` |
| `read_only` | `false` | Never send anything to any light (direct drivers still discover) |
| `drivers` | all `true` | `z2m`, `zwave_js`, `wiz`, `wled`, `govee`: switch a direct driver off and its lights go through HA |
| `wiz_subnets` | `[192.168.10.0/24]` | Swept for WiZ bulbs (`/22` at most each) |
| `govee_subnets` | `[192.168.10.0/24]` | Swept for Govee devices, besides the multicast scan |
| `govee_razer_models` | `[]` | Govee models (e.g. `H7055`) whose segment streaming has been tested and may be used |
| `z2m_base_topic` | `zigbee2mqtt` | Optional |
| `zwave_url` | (discovered) | Optional: the Z-Wave JS server, e.g. `ws://core-zwave-js:3000` |

## Logs

HA → the add-on's Log tab, or `GET /api/hassio/addons/<slug>/logs` with an admin token.
