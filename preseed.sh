#!/usr/bin/env bash
# Pre-seed the transformers.js weights cache using curl (the Node undici fetch
# cannot sustain large streaming bodies through this network's CDN, but curl can).
# Layout mirrors what @huggingface/transformers@3.3.3 stores under env.cacheDir.
set -u
CACHE=".cache/transformers/Xenova"
mkdir -p "$CACHE"

dl() { # dl <model> <file>
  local model="$1" file="$2"
  local dst="$CACHE/$model/$file"
  if [ -s "$dst" ]; then echo "cached: $model/$file"; return; fi
  mkdir -p "$(dirname "$dst")"
  local url="https://huggingface.co/$model/resolve/main/$file"
  for i in 1 2 3 4 5; do
    curl -s -L --fail --max-time 600 -o "$dst.tmp" "$url"
    rc=$?
    if [ $rc -eq 0 ] && [ -s "$dst.tmp" ]; then
      if head -c 200 "$dst.tmp" | grep -qi '<!DOCTYPE html' ; then rm -f "$dst.tmp"; else mv "$dst.tmp" "$dst"; echo "ok: $model/$file"; return; fi
    else
      rm -f "$dst.tmp"
    fi
    sleep 2
  done
  echo "FAILED: $model/$file"
}

BERT_COMMON="config.json tokenizer.json tokenizer_config.json special_tokens_map.json vocab.txt onnx/model_quantized.onnx"
for m in Xenova/all-MiniLM-L6-v2 Xenova/mobilebert-uncased-mnli Xenova/bert-base-NER; do
  for f in $BERT_COMMON; do
    dl "$m" "$f" &
  done
done

T5=Xenova/LaMini-Flan-T5-248M
mkdir -p "$CACHE/$T5"
for f in config.json tokenizer.json tokenizer_config.json special_tokens_map.json spiece.model generation_config.json \
         onnx/encoder_model_quantized.onnx onnx/decoder_model_quantized.onnx \
         onnx/decoder_with_past_model_quantized.onnx onnx/decoder_model_merged_quantized.onnx; do
  dl "$T5" "$f" &
done

wait
echo "DONE"