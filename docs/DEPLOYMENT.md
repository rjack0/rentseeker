# Deployment

## Local Containers

- `Dockerfile` builds the platform image.
- `docker-compose.yml` provisions the CLI container, the Streamlit UI, and Redis.

## Production Considerations

- Replace local JSON/CSV sinks with cloud or database-backed output connectors.
- Run discovery workers separately from the Streamlit UI.
- Use a durable broker such as Redis, Kafka, or SQS.
- Store result artifacts under partitioned paths by run ID.
- Attach metrics and alerts defined in `config/deployment.yaml`.

## Security

- Prefer secret injection through environment variables or a secret manager.
- Avoid putting API credentials directly into project YAML files.
- Enable audit logging and immutable export manifests for regulated use cases.

