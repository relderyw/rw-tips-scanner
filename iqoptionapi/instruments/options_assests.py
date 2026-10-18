"""
Dynamic asset registry for IQ Option.
No hardcoded/mocked asset list.
Populated at runtime directly from IQ Option WebSocket initialization data.
"""
from typing import Dict

# Dynamic registry mapping ticker/symbol -> active_id (populated from broker)
UNDERLYING_ASSESTS: Dict[str, int] = {}
