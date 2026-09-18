// background.js — service worker (Manifest V3)

import { setupLifecycle } from "./core/usecases/LifecycleController.js";
import { setupMessages } from "./core/usecases/MessageController.js";

// Clean Architecture: 
// - LifecycleController manages chrome events (onInstalled, onStartup, alarms)
// - MessageController handles messages from the UI popup
// - VideoUseCases encapsulates business logic

setupLifecycle();
setupMessages();
