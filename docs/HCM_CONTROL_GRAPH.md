# HCM Control Graph

> Version `0.1`. This layer separates physical smart-home hardware from the objects a resident actually intends to control.

## Why It Exists

A Home Assistant device is not always a user-facing device. A two-gang wall switch is one provider device, but it may control two different lighting circuits in another room. Treating the panel as one HCM target causes three failures:

- room assignment follows the panel instead of the controlled light;
- commands such as `关闭餐厅所有灯` cannot enumerate individual circuits;
- similarly named lights can be selected across rooms.

Harness House therefore keeps the provider graph unchanged and derives a separate control graph.

```text
Controller (physical panel)
  -> Endpoint (relay/channel/entity)
  -> controls
Asset (logical light or appliance)
  -> located_in
Space (semantic room)
```

## Node Types

### Controller

- Physical smart controller or panel.
- References a stable HCM `thing` and provider device identity.
- Has an installation location with source and confidence.
- Is shown in maintenance/configuration views, not as the default conversational target.

### Endpoint

- One independently addressable relay or channel.
- References the original HCM capability and HA entity ID.
- Records channel (`left`, `middle`, `right`), provider state, policy, mapping status, source, and confidence.
- An unused key remains `unbound`; it is never turned into an AI-controllable asset by guessing.

### Asset

- User-facing controlled object, for example `餐厅射灯`.
- Has a semantic room independent of controller installation.
- Can be controlled by one or more endpoints.
- Relay state is represented as `commandedState`; actual lamp output remains `observedState: unknown` unless independent evidence exists.

### Relationship

Supported relation types:

- `relay_control`
- `remote_control`
- `scene_trigger`
- `power_dependency`

The schema allows many-to-many relationships so two-way switching and grouped circuits do not require a later data-model rewrite.

## Mapping Status

- `bound`: executable logical mapping is available.
- `review`: a candidate exists but is a remote binding or lacks enough primary-actuator evidence.
- `unbound`: no controlled object is known or the key is unused.
- `ignored`: the user intentionally removed the endpoint from the household model.

Automatic inference uses relay-shaped provider entities, lighting semantics, room terms in channel names, and the existing capability policy. Explicit controlled-load room semantics take precedence over the physical controller's HA Area. Configuration entities such as interlock, flexible mode, and key-mode settings are not relay endpoints; named remote-control bindings remain separate `remote_control/review` relationships and cannot become the primary actuator.

User confirmation is stored in the local HCM Overlay, keyed by stable provider entity ID:

```json
{
  "status": "bound",
  "assetName": "书房射灯",
  "spaceId": "study",
  "relationType": "relay_control"
}
```

API:

```text
POST /api/hcm/overrides/control-mappings
```

## Planner And Execution

The planner sees logical assets instead of multi-gang switch panels. A model action such as:

```json
{"device_id":"asset_dining_餐厅射灯","capability":"power","value":false}
```

is normalized locally to the original physical HCM thing and capability. Safety Gate, Policy Gate, provider simulation, and authorized execution still operate on the provider-backed capability.

Explicit room names are hard constraints for logical assets. If the user asks for a study light, a living-room or dining-room asset is rejected during normalization even if the model selected it.

## Digital Twin Projection

- Life view displays logical assets in their semantic rooms.
- Maintenance view will display controllers at their installation positions and relationships to assets.
- Preview/execution highlights target logical asset IDs, while audit records both logical and provider identities.
- Deleting the map does not delete HCM mappings or provider bindings.

## Safety Boundary

- Inference never changes HA entity names or HA Area assignments.
- `review` and `unbound` endpoints are not exposed as executable logical assets.
- Toggle-only buttons are not treated as deterministic on/off relays.
- Provider configuration switches are excluded from the control graph.
- Automated tests and development verification use provider snapshots and dry-run simulation only.
