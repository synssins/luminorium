# Deployment

Luminorium is installed as a Home Assistant add-on from this repository
(`https://github.com/synssins/luminorium`, private for now).

## Add-on files

| File | What |
|---|---|
| `repository.yaml` | Makes the repository an add-on repository |
| `luminorium_addon/config.yaml` | Add-on manifest: version, slug `luminorium`, `arch: [amd64]`, Ingress on 8199, `homeassistant_api`, `hassio_api`, `addon_config` map, options |
| `luminorium_addon/build.yaml` | `build_from`: `ghcr.io/home-assistant/amd64-base-debian:trixie-2026.10.0` |
| `luminorium_addon/Dockerfile` | Python 3.13 from Debian in `/opt/venv`, requirements, the `luminorium` package; `CMD /run.sh` |
| `luminorium_addon/run.sh` | `exec python3 -m luminorium` |
| `luminorium_addon/DOCS.md` | Shown in HA's add-on page |
| `luminorium_addon/CHANGELOG.md` | Shown when updating |

## Choices and why

- **Debian base, not Alpine:** `opencv-python-headless` (phase 5 mapping) has no musllinux wheels.
- **amd64 only:** the HA host is generic x86-64. Add aarch64 when there's a reason.
- **No host networking yet:** phase 1 only talks to HA. Phase 2 (WiZ, WLED, Govee over UDP)
  turns on `host_network`; the web server already refuses anything but the ingress proxy, and the
  Ingress port (8199) avoids Zigbee2MQTT's 8099 on the host.
- **Built on the HA host:** there is no prebuilt image (`image:` is not set), so the Supervisor
  builds the Dockerfile on install and update.

## Rules learned from Bifrost

- **Every build gets a new `version`** in `config.yaml` (and `luminorium/__init__.py`). HA reuses a
  cached image when the version is unchanged.
- **Never put a digest in `build_from`.** The Supervisor then silently builds from its own base
  image instead. Pin a dated tag.
- Back up before replacing anything on the HA host.

## Install

1. In HA: Settings → Add-ons → Add-on store → ⋮ → Repositories → add the repository URL. A private
   repository needs credentials the Supervisor can use (for example a URL with a read-only token).
2. Install **Luminorium**. Before the first start, turn on the `read_only` option to look around
   without touching any light.
3. Start it and open it from the sidebar.

## Options

| Option | Default | What |
|---|---|---|
| `log_level` | `info` | `debug`, `info`, `warning`, `error` |
| `read_only` | `false` | Never send anything to any light |

## Logs

HA → the add-on's Log tab, or `GET /api/hassio/addons/<slug>/logs` with an admin token.
