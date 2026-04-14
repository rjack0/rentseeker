from __future__ import annotations

import asyncio
from collections.abc import Iterable

from phoenix.config import PhoenixConfig
from phoenix.connectors.discovery.registry import build_discovery_connectors
from phoenix.connectors.input.registry import build_input_connector
from phoenix.connectors.output.registry import build_output_connectors

from .core.expander import EntityGraphExpander
from .core.normalization import EntityNormalizer
from .core.orchestrator import RecursiveDiscoveryOrchestrator
from .core.scorer import SignalPreScorer
from .core.scoring import ConfidenceScorer
from .core.verification import ConsensusVerificationEngine
from .core.models import DiscoveryRunResult


class DiscoveryPipeline:
    """Composable end-to-end discovery pipeline."""

    def __init__(self, config: PhoenixConfig) -> None:
        self.config = config
        self.input_connector = build_input_connector(config.input)
        self.discovery_connectors = build_discovery_connectors(config.connectors)
        self.output_connectors = build_output_connectors(config.output)
        self.normalizer = EntityNormalizer(config.project, config.input)
        self.pre_scorer = SignalPreScorer(config.scoring)
        self.expander = EntityGraphExpander(config.expansion)
        self.verifier = ConsensusVerificationEngine()
        self.confidence = ConfidenceScorer(config.scoring)
        self.orchestrator = RecursiveDiscoveryOrchestrator(
            self.discovery_connectors,
            config.runtime,
        )

    def run(self) -> list[DiscoveryRunResult]:
        results: list[DiscoveryRunResult] = []
        for record in self.input_connector.read(self.config.input.model_dump(by_alias=True)):
            entity = self.normalizer.normalize_record(record)
            signal_score = self.pre_scorer.score(entity)
            route = self.pre_scorer.route(signal_score)

            if route == "skip":
                results.append(
                    DiscoveryRunResult(
                        entity_id=entity.entity_id or entity.compute_id(),
                        signal_score=signal_score,
                        route=route,
                        confidence=self.confidence.score(entity, [], []),
                    )
                )
                continue

            nodes = self.expander.expand(entity)
            attributes = asyncio.run(self._discover_nodes(nodes, route))
            verifications = self.verifier.verify(attributes)
            confidence = self.confidence.score(entity, attributes, verifications)

            result = DiscoveryRunResult(
                entity_id=entity.entity_id or entity.compute_id(),
                signal_score=signal_score,
                route=route,
                nodes=nodes,
                attributes=attributes,
                verifications=verifications,
                confidence=confidence,
            )
            results.append(result)

        self._export(results)
        return results

    async def _discover_nodes(self, nodes: Iterable[object], route: str) -> list[object]:
        attributes: list[object] = []
        for node in nodes:
            attributes.extend(await self.orchestrator.discover(node, route))
        return attributes

    def _export(self, results: list[DiscoveryRunResult]) -> None:
        destinations: list[str] = []
        for connector in self.output_connectors:
            destinations.append(connector.write([result.model_dump(mode="json") for result in results]))
        for result in results:
            result.exported_to.extend(destinations)
