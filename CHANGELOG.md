# Changelog

## [0.5.0](https://github.com/mingchuno/agent-workflows/compare/v0.4.1...v0.5.0) (2026-09-23)


### Features

* **monitor:** Expose agent preflight diagnostics ([14a7f5b](https://github.com/mingchuno/agent-workflows/commit/14a7f5b335b427f5c088d2a04d7f3a267f458597))
* **retry:** Support refreshing the issue snapshot ([cfe37c2](https://github.com/mingchuno/agent-workflows/commit/cfe37c27245a26fff14ecdde2a5086d3fbffd127))
* **validation:** Add ticket-selected check profiles ([2b8ed4d](https://github.com/mingchuno/agent-workflows/commit/2b8ed4d9113f41786c9c0571abb4645278d25002))

## [0.4.1](https://github.com/mingchuno/agent-workflows/compare/v0.4.0...v0.4.1) (2026-09-22)


### Bug Fixes

* **store:** make state and event writes atomic ([51dbca4](https://github.com/mingchuno/agent-workflows/commit/51dbca4aa53ac252a9939c23be0e5eed08e1a6a9))

## [0.4.0](https://github.com/mingchuno/agent-workflows/compare/v0.3.0...v0.4.0) (2026-09-21)


### Features

* **cli:** load environment file from config ([ea4b5e7](https://github.com/mingchuno/agent-workflows/commit/ea4b5e7375aeb1a16762ee1c43d8c3e3a9c9c68a))

## [0.3.0](https://github.com/mingchuno/agent-workflows/compare/v0.2.0...v0.3.0) (2026-09-21)


### ⚠ BREAKING CHANGES

* relative CLI configuration paths now resolve from the configuration file directory, and the gitIdentity setting has been removed.

### Features

* make config paths portable and attribute agent contributions ([#6](https://github.com/mingchuno/agent-workflows/issues/6)) ([ba8eff1](https://github.com/mingchuno/agent-workflows/commit/ba8eff1f32738e4428f0f4c64561711e3dee7dbb))
* **tui:** notify on execution outcomes ([#11](https://github.com/mingchuno/agent-workflows/issues/11)) ([e5eeb1e](https://github.com/mingchuno/agent-workflows/commit/e5eeb1ef43ca2ef62a2574ad14f56e9c17d2a4d4))
* **tui:** redesign Run details around operator needs ([#10](https://github.com/mingchuno/agent-workflows/issues/10)) ([c66c6c8](https://github.com/mingchuno/agent-workflows/commit/c66c6c886e25fc58fe1ae007f11b28418897c311))

## [0.2.0](https://github.com/mingchuno/agent-workflows/compare/v0.1.0...v0.2.0) (2026-09-20)


### Features

* **cli:** load explicit environment files ([fe8350e](https://github.com/mingchuno/agent-workflows/commit/fe8350e6dcf8b3d7e64011c42aa22fe64e73fc90))
* recover failed publication steps ([46b187a](https://github.com/mingchuno/agent-workflows/commit/46b187abf12b4b94e72873b9caa1ba568adb0f8a))
* **tui:** redesign the workflow monitor ([71b2cd0](https://github.com/mingchuno/agent-workflows/commit/71b2cd03a2dc6ca0e9a85fc34f21809ff8b7b062))
* **workflows:** Harden agent stage execution ([75c699e](https://github.com/mingchuno/agent-workflows/commit/75c699ea6d342970d888f831b8f7506f356c4ccc))

## 0.1.0 (2026-09-20)


### Features

* initial Phase 1 implementation ([be7291e](https://github.com/mingchuno/agent-workflows/commit/be7291e1b0d1fa57479086691cef3aa476a045ad))
* phase 1 review and refactor ([b989244](https://github.com/mingchuno/agent-workflows/commit/b9892445cc24b96fac4d2ba96c8dd1697128d4e7))


### Bug Fixes

* address phase 1 gaps ([4657807](https://github.com/mingchuno/agent-workflows/commit/4657807ddddd9d4d137409ad9a9248f1b3efefc5))
