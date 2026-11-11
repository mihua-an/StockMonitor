"""The deployable training path: online-v3 features -> authority-driven labels -> dataset ->
per-horizon/direction training -> exported model -> registry the inference worker loads from.

Everything here is keyed by the ONE horizon authority (config/prediction_horizons.json, minutes).
Nothing silently substitutes another horizon: a horizon not in the authority, not in a dataset, or
without labels is refused with a reason.
"""
