from fastapi import FastAPI

app = FastAPI(title="MacroByte BK Tool API")

@app.get("/health")
def health_check():
    return {"status": "ok"}