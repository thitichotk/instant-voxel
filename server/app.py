"""VOXY model server — the job API the web app's "Model server" provider speaks.

    GET  /v1/health            → { ok, device, image: true, text: true }
    POST /v1/jobs              multipart: image? (PNG/JPEG/WebP ≤ 10 MB), prompt?, seed?  → 202 { id }
    GET  /v1/jobs/{id}         → { status: queued|running|done|error, stage, error? }
    GET  /v1/jobs/{id}/result  → model/gltf-binary

Optional auth: set API_KEY and send `Authorization: Bearer <key>`.
CORS: ALLOWED_ORIGINS (comma-separated) or the defaults below.
Run from this directory:  uvicorn app:app --port 8000

ponytail: jobs live in memory and run one at a time on one GPU; a hosted
SaaS would swap in a persistent queue and object storage behind the same API.
"""

import io
import os
import queue
import threading
import uuid
from collections import OrderedDict

from fastapi import Depends, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response
from PIL import Image

import models

MAX_UPLOAD = 10 * 1024 * 1024
MAX_PROMPT = 500
MAX_QUEUED = 8
KEEP_JOBS = 32
ORIGINS = os.environ.get(
    "ALLOWED_ORIGINS",
    "http://127.0.0.1:3000,http://localhost:3000,https://thitichotk.github.io,https://voxel.thitichotk.com",
).split(",")
API_KEY = os.environ.get("API_KEY")

app = FastAPI(title="VOXY model server")
app.add_middleware(CORSMiddleware, allow_origins=ORIGINS, allow_methods=["GET", "POST"], allow_headers=["Authorization"])


@app.middleware("http")
async def private_network(request: Request, call_next):
    # Chrome asks before a public page (e.g. GitHub Pages) may call a local server.
    response = await call_next(request)
    if request.headers.get("access-control-request-private-network"):
        response.headers["Access-Control-Allow-Private-Network"] = "true"
    return response


def authorized(request: Request):
    if API_KEY and request.headers.get("authorization") != f"Bearer {API_KEY}":
        raise HTTPException(401, "Missing or wrong API key.")


jobs = OrderedDict()   # id → { status, stage, error, result }
work = queue.Queue(MAX_QUEUED)
lock = threading.Lock()


def worker():
    while True:
        job_id, image, prompt, seed = work.get()
        job = jobs[job_id]

        def stage(s):
            job["stage"] = s

        job["status"] = "running"
        try:
            if image is None:
                image = models.text_to_image(prompt, seed, stage)
            job["result"] = models.image_to_glb(image, stage)
            job.update(status="done", stage="done")
        except Exception as err:  # reported to the client, then the next job runs
            job.update(status="error", error=str(err))


threading.Thread(target=worker, daemon=True).start()


@app.get("/v1/health", dependencies=[Depends(authorized)])
def health():
    return {"ok": True, "device": models.device(), "image": True, "text": True}


@app.post("/v1/jobs", status_code=202, dependencies=[Depends(authorized)])
async def create_job(image: UploadFile | None = File(None), prompt: str | None = Form(None), seed: int | None = Form(None)):
    prompt = (prompt or "").strip()
    if image is None and not prompt:
        raise HTTPException(422, "Send an image, a prompt, or both.")
    if len(prompt) > MAX_PROMPT:
        raise HTTPException(422, f"Prompt is over {MAX_PROMPT} characters.")
    picture = None
    if image is not None:
        data = await image.read(MAX_UPLOAD + 1)
        if len(data) > MAX_UPLOAD:
            raise HTTPException(413, "Image is over 10 MB.")
        try:
            picture = Image.open(io.BytesIO(data))
            if picture.format not in ("PNG", "JPEG", "WEBP"):
                raise ValueError(picture.format)
            picture.load()
        except Exception:
            raise HTTPException(415, "Image must be a PNG, JPEG or WebP.")

    job_id = uuid.uuid4().hex
    with lock:
        jobs[job_id] = {"status": "queued", "stage": "queued", "error": None, "result": None}
        while len(jobs) > KEEP_JOBS:
            jobs.popitem(last=False)
    try:
        work.put_nowait((job_id, picture, prompt, seed))
    except queue.Full:
        jobs.pop(job_id, None)
        raise HTTPException(503, "The server is busy; try again shortly.")
    return {"id": job_id}


def find(job_id):
    job = jobs.get(job_id)
    if job is None:
        raise HTTPException(404, "No such job.")
    return job


@app.get("/v1/jobs/{job_id}", dependencies=[Depends(authorized)])
def job_status(job_id: str):
    job = find(job_id)
    return JSONResponse({k: job[k] for k in ("status", "stage", "error") if job[k] is not None})


@app.get("/v1/jobs/{job_id}/result", dependencies=[Depends(authorized)])
def job_result(job_id: str):
    job = find(job_id)
    if job["status"] != "done":
        raise HTTPException(409, f"Job is {job['status']}.")
    return Response(job["result"], media_type="model/gltf-binary")
