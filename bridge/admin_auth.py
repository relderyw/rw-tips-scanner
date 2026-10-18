"""Firebase Admin SDK helpers for trusted app-user administration."""
from __future__ import annotations

import json
import logging
import os
from functools import lru_cache
from datetime import datetime, timezone
from typing import Any, Dict

import firebase_admin
from firebase_admin import auth, credentials
from firebase_admin.exceptions import FirebaseError
from fastapi import HTTPException

_BRIDGE_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_DIR = os.path.dirname(_BRIDGE_DIR)
log = logging.getLogger("bridge.admin")


@lru_cache(maxsize=1)
def _initialize_firebase_admin():
    try:
        return firebase_admin.get_app()
    except ValueError:
        pass

    credentials_json = os.getenv("FIREBASE_ADMIN_CREDENTIALS_JSON")
    credentials_path = os.getenv("FIREBASE_ADMIN_CREDENTIALS")
    if credentials_json:
        try:
            service_account = json.loads(credentials_json)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=503,
                detail="A configuração JSON do Firebase Admin SDK é inválida.",
            ) from exc
        credential = credentials.Certificate(service_account)
    else:
        candidate_dirs = [_BRIDGE_DIR, _REPO_DIR, os.getcwd()]
        found_path = None

        # 1. Tenta caminhos explícitos via variáveis de ambiente
        explicit_candidates = [
            credentials_path,
            os.getenv("FIREBASE_SERVICE_ACCOUNT_FILE"),
            "rw-tips-firebase-adminsdk-fbsvc-83ccc19671.json",
        ]
        for exp in explicit_candidates:
            if not exp:
                continue
            if os.path.isabs(exp) and os.path.isfile(exp):
                found_path = exp
                break
            for d in candidate_dirs:
                p = os.path.join(d, exp)
                if os.path.isfile(p):
                    found_path = p
                    break
            if found_path:
                break

        # 2. Se ainda não encontrou, busca por prefixo nos diretórios candidatos
        if not found_path:
            for d in candidate_dirs:
                if not os.path.isdir(d):
                    continue
                try:
                    for fname in os.listdir(d):
                        if (fname.startswith("rw-tips-firebase-adminsdk") or "firebase-adminsdk" in fname) and fname.endswith(".json"):
                            p = os.path.join(d, fname)
                            if os.path.isfile(p):
                                found_path = p
                                break
                except Exception:
                    pass
                if found_path:
                    break

        if not found_path or not os.path.isfile(found_path):
            raise HTTPException(
                status_code=503,
                detail="Configure as credenciais Firebase Admin SDK no servidor.",
            )
        log.info("Firebase Admin SDK inicializado com credenciais: %s", found_path)
        credential = credentials.Certificate(found_path)

    project_id = os.getenv("FIREBASE_PROJECT_ID")
    options = {"projectId": project_id} if project_id else None
    return firebase_admin.initialize_app(credential, options=options)


def verify_firebase_token(token: str) -> Dict[str, Any]:
    _initialize_firebase_admin()
    try:
        return auth.verify_id_token(token, check_revoked=True)
    except (auth.InvalidIdTokenError, auth.ExpiredIdTokenError, auth.RevokedIdTokenError) as exc:
        raise HTTPException(status_code=401, detail="Sessão Firebase inválida ou expirada.") from exc
    except auth.UserDisabledError as exc:
        raise HTTPException(status_code=403, detail="Esta conta Firebase está desativada.") from exc
    except FirebaseError as exc:
        raise HTTPException(status_code=503, detail="Não foi possível validar a sessão com o Firebase.") from exc


def require_admin(token: str) -> Dict[str, Any]:
    decoded = verify_firebase_token(token)
    configured_email = os.getenv("FIREBASE_ADMIN_EMAIL", "").strip().casefold()
    user_email = str(decoded.get("email", "")).strip().casefold()
    if not configured_email:
        raise HTTPException(
            status_code=503,
            detail="Configure o e-mail administrador no servidor.",
        )
    if not user_email or user_email != configured_email:
        raise HTTPException(status_code=403, detail="Acesso restrito ao administrador.")
    return decoded


def create_limited_user(email: str, password: str, days: int) -> Dict[str, Any]:
    _initialize_firebase_admin()
    normalized_email = email.strip().casefold()
    try:
        user = auth.create_user(email=normalized_email, password=password)
    except auth.EmailAlreadyExistsError as exc:
        raise HTTPException(status_code=409, detail="Este e-mail já possui uma conta.") from exc
    except ValueError as exc:
        raise HTTPException(status_code=422, detail="Confira o e-mail e a senha informados.") from exc
    except FirebaseError as exc:
        raise HTTPException(status_code=502, detail="O Firebase não conseguiu criar a conta.") from exc

    expires_at = int(datetime.now(timezone.utc).timestamp()) + days * 86400
    try:
        auth.set_custom_user_claims(user.uid, {"access_expires_at": expires_at})
    except Exception as exc:
        try:
            auth.delete_user(user.uid)
        except Exception:
            log.exception(
                "Failed to remove newly created Firebase user after setting expiry claims failed."
            )
        log.error("Failed to set expiry claim for a newly created Firebase user (%s).", type(exc).__name__)
        raise HTTPException(
            status_code=502,
            detail="Não foi possível definir a validade do acesso. A operação foi cancelada; tente novamente.",
        ) from exc

    return {
        "uid": user.uid,
        "email": user.email,
        "expires_at": datetime.fromtimestamp(expires_at, timezone.utc).isoformat(),
    }
