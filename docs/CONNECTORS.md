# Connectors

The system uses three connector families.

## Input Connectors

- `CSVConnector`
- `ExcelConnector`
- `JSONConnector`
- `APIConnector`

Each input connector implements:

- `can_handle`
- `read`
- `get_schema_hint`

## Discovery Connectors

- `WebSearchConnector`
- `APILookupConnector`
- `DocumentParserConnector`
- `PatternMatcherConnector`
- `GraphTraversalConnector`
- `CustomTemplateConnector`

Each discovery connector implements:

- `can_handle`
- `discover`
- `supports_route`

## Output Connectors

- `FileOutputConnector`
- `DatabaseOutputConnector`
- `WebhookOutputConnector`

## Adding a Custom Connector

1. Create a new class under `phoenix/connectors/discovery/`.
2. Inherit from `DiscoveryConnector`.
3. Implement `can_handle` and `discover`.
4. Register the class in `phoenix/connectors/discovery/registry.py`.
5. Add the connector to YAML config under `connectors`.

