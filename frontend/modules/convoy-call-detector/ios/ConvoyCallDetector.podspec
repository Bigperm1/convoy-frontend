Pod::Spec.new do |s|
  s.name           = 'ConvoyCallDetector'
  s.version        = '1.0.0'
  s.summary        = 'Phone-call detection for ducking Nova.'
  s.description    = 'Reports whether the user is on a phone call via CXCallObserver.'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = {
    :ios => '15.1',
    :tvos => '15.1'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
